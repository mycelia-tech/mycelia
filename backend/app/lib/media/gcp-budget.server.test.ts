import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
} from "jsr:@std/assert@^1.0.15";
import type { Db } from "mongodb";
import { zMediaKnowledgeConfig } from "@myceliasdk/media.ts";
import {
  beginGcpBudgetExecution,
  finishGcpBudget,
  GcpBudgetAttemptBusyError,
  GcpBudgetExecutionLeaseLostError,
  reconcileReadyGcpBudget,
  releaseUnstartedGcpBudgetAttempt,
  reserveGcpBudget,
} from "./gcp-budget.server.ts";
import {
  claimMediaAnalysisRun,
  markMediaRunFailed,
  markMediaRunOutcomeUnknown,
  markMediaRunProviderStarted,
  markMediaRunReady,
  MediaRunClaimLostError,
} from "./media-run-claim.server.ts";

type Document = Record<string, any>;

function valueAt(document: Document, path: string): any {
  return path.split(".").reduce((value, part) => value?.[part], document);
}

function setAt(document: Document, path: string, value: any): void {
  const parts = path.split(".");
  let target = document;
  for (const part of parts.slice(0, -1)) {
    target[part] ??= {};
    target = target[part];
  }
  target[parts.at(-1)!] = value;
}

function unsetAt(document: Document, path: string): void {
  const parts = path.split(".");
  const target = parts.slice(0, -1).reduce(
    (value, part) => value?.[part],
    document,
  );
  if (target) delete target[parts.at(-1)!];
}

function equalValue(left: any, right: any): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  return left === right;
}

function matchesValue(actual: any, expected: any): boolean {
  if (
    expected && typeof expected === "object" && !(expected instanceof Date) &&
    Object.keys(expected).some((key) => key.startsWith("$"))
  ) {
    if ("$exists" in expected) {
      return expected.$exists ? actual !== undefined : actual === undefined;
    }
    if ("$in" in expected) {
      return expected.$in.some((value: any) => equalValue(actual, value));
    }
    if ("$ne" in expected) {
      return Array.isArray(actual)
        ? !actual.some((value) => equalValue(value, expected.$ne))
        : !equalValue(actual, expected.$ne);
    }
    if ("$lte" in expected) return actual <= expected.$lte;
    if ("$gt" in expected) return actual > expected.$gt;
  }
  if (Array.isArray(actual)) {
    return actual.some((value) => equalValue(value, expected));
  }
  return equalValue(actual, expected);
}

function matches(document: Document, filter: Document): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") {
      return (expected as Document[]).some((entry) => matches(document, entry));
    }
    return matchesValue(valueAt(document, key), expected);
  });
}

function applyUpdate(document: Document, update: Document, inserted: boolean) {
  if (inserted) {
    for (const [path, value] of Object.entries(update.$setOnInsert ?? {})) {
      setAt(document, path, structuredClone(value));
    }
  }
  for (const [path, value] of Object.entries(update.$set ?? {})) {
    setAt(document, path, structuredClone(value));
  }
  for (const [path, value] of Object.entries(update.$inc ?? {})) {
    setAt(document, path, Number(valueAt(document, path) ?? 0) + Number(value));
  }
  for (const [path, value] of Object.entries(update.$addToSet ?? {})) {
    const values = valueAt(document, path) ?? [];
    if (!values.some((entry: any) => equalValue(entry, value))) {
      values.push(structuredClone(value));
    }
    setAt(document, path, values);
  }
  for (const path of Object.keys(update.$unset ?? {})) unsetAt(document, path);
}

class FakeCollection {
  constructor(
    readonly name: string,
    readonly documents: Document[],
    readonly controls: { failEventFinalizationOnce: boolean },
  ) {}

  async insertOne(document: Document) {
    const duplicate = this.documents.some((entry) =>
      this.name === "gcp_usage_events"
        ? entry.attemptId === document.attemptId
        : entry._id === document._id
    );
    if (duplicate) throw Object.assign(new Error("duplicate"), { code: 11000 });
    this.documents.push(structuredClone(document));
    return { insertedId: document._id ?? crypto.randomUUID() };
  }

  async findOne(filter: Document) {
    const value = this.documents.find((entry) => matches(entry, filter));
    return value ? structuredClone(value) : null;
  }

  async deleteOne(filter: Document) {
    const index = this.documents.findIndex((entry) => matches(entry, filter));
    if (index < 0) return { deletedCount: 0 };
    this.documents.splice(index, 1);
    return { deletedCount: 1 };
  }

  async updateOne(
    filter: Document,
    update: Document,
    options: { upsert?: boolean } = {},
  ) {
    if (
      this.name === "gcp_usage_events" &&
      this.controls.failEventFinalizationOnce &&
      filter.state === "settling" &&
      ["committed", "unknown", "released"].includes(update.$set?.state)
    ) {
      this.controls.failEventFinalizationOnce = false;
      throw new Error("simulated process crash after ledger settlement");
    }
    const index = this.documents.findIndex((entry) => matches(entry, filter));
    if (index >= 0) {
      applyUpdate(this.documents[index], update, false);
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    }
    if (!options.upsert) {
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    }
    if (
      filter._id !== undefined &&
      this.documents.some((entry) => equalValue(entry._id, filter._id))
    ) throw Object.assign(new Error("duplicate"), { code: 11000 });
    const document: Document = {};
    for (const [key, value] of Object.entries(filter)) {
      if (!key.startsWith("$") && typeof value !== "object") {
        setAt(document, key, value);
      }
    }
    applyUpdate(document, update, true);
    this.documents.push(document);
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
  }

  async findOneAndUpdate(
    filter: Document,
    update: Document,
    options: { returnDocument?: "before" | "after" } = {},
  ) {
    const index = this.documents.findIndex((entry) => matches(entry, filter));
    if (index < 0) return null;
    const before = structuredClone(this.documents[index]);
    applyUpdate(this.documents[index], update, false);
    return options.returnDocument === "after"
      ? structuredClone(this.documents[index])
      : before;
  }
}

class FakeDb {
  readonly data = new Map<string, Document[]>();
  readonly controls = { failEventFinalizationOnce: false };

  collection(name: string) {
    const documents = this.data.get(name) ?? [];
    this.data.set(name, documents);
    return new FakeCollection(name, documents, this.controls);
  }
}

const now = new Date("2026-08-22T12:00:00.000Z");
const projectId = "mycelia-media-test";

function config() {
  return zMediaKnowledgeConfig.parse({
    promoGuard: {
      promotionExpiresAt: "2026-09-24T00:00:00.000Z",
      stopBeforeHours: 72,
      monthlyGrossLimitUsd: 1,
      dailyGrossLimitUsd: 0.1,
      perImportGrossLimitUsd: 0.01,
      creditVerifiedAt: now.toISOString(),
      creditVerifiedProjectId: projectId,
      verifiedRemainingUsd: 300,
      verifiedBillingAccountType: "free_trial",
      creditVerifiedBillingAccountType: "free_trial",
      creditVerifiedPromotionExpiresAt: "2026-09-24T00:00:00.000Z",
    },
  });
}

function ledger(db: FakeDb): Document {
  const value = db.data.get("gcp_usage_months")?.[0];
  if (!value) throw new Error("missing fake ledger");
  return value;
}

function event(db: FakeDb): Document {
  const value = db.data.get("gcp_usage_events")?.[0];
  if (!value) throw new Error("missing fake event");
  return value;
}

Deno.test("disabling the daily stop permits more than $50 but preserves the monthly stop", async () => {
  const fake = new FakeDb();
  const db = fake as unknown as Db;
  const settings = config();
  settings.promoGuard.monthlyGrossLimitUsd = 300;
  settings.promoGuard.dailyGrossLimitUsd = null;
  fake.data.set("gcp_usage_months", [{
    _id: `${projectId}:2026-08`,
    revision: 0,
    grossCommittedUsd: 51,
    grossReservedUsd: 0,
    days: { "2026-08-22": { grossUsd: 51 } },
  }]);
  await reserveGcpBudget(
    db,
    "owner-a",
    "over-daily",
    0.006,
    settings,
    projectId,
    { now },
  );
  assertEquals(ledger(fake).grossReservedUsd, 0.006);
  assertEquals(ledger(fake).days["2026-08-22"].grossUsd, 51.006);

  settings.promoGuard.dailyGrossLimitUsd = 50;
  await assertRejects(
    () =>
      reserveGcpBudget(
        db,
        "owner-a",
        "daily-blocked",
        0.006,
        settings,
        projectId,
        { now },
      ),
    Error,
    "GCP_DAILY_BUDGET_BLOCKED",
  );

  settings.promoGuard.dailyGrossLimitUsd = null;
  settings.promoGuard.monthlyGrossLimitUsd = 51.01;
  await assertRejects(
    () =>
      reserveGcpBudget(
        db,
        "owner-a",
        "monthly-blocked",
        0.006,
        settings,
        projectId,
        { now },
      ),
    Error,
    "GCP_MONTHLY_BUDGET_BLOCKED",
  );
  assertEquals(ledger(fake).grossReservedUsd, 0.006);
});

Deno.test("a live budget claim cannot be inherited by a duplicate provider call", async () => {
  const fake = new FakeDb();
  const db = fake as unknown as Db;
  const claim = await reserveGcpBudget(
    db,
    "owner-a",
    "run:job",
    0.006,
    config(),
    projectId,
    { now, leaseMs: 1_000, executionId: "execution-a" },
  );

  const error = await assertRejects(() =>
    reserveGcpBudget(
      db,
      "owner-a",
      "run:job",
      0.006,
      config(),
      projectId,
      { now, executionId: "execution-b" },
    )
  );
  assertInstanceOf(error, GcpBudgetAttemptBusyError);
  assertEquals(ledger(fake).grossReservedUsd, 0.006);
  assertEquals(ledger(fake).reservationAttemptIds, ["run:job"]);

  await beginGcpBudgetExecution(db, claim, new Date(now.getTime() + 500));
  const staleDuplicate = await assertRejects(() =>
    reserveGcpBudget(
      db,
      "owner-a",
      "run:job",
      0.006,
      config(),
      projectId,
      { now: new Date(now.getTime() + 2_000), executionId: "execution-c" },
    )
  );
  assertInstanceOf(staleDuplicate, GcpBudgetAttemptBusyError);
});

Deno.test("an expired claim is reusable only before the provider-start marker", async () => {
  const fake = new FakeDb();
  const db = fake as unknown as Db;
  const first = await reserveGcpBudget(
    db,
    "owner-a",
    "run:job",
    0.006,
    config(),
    projectId,
    { now, leaseMs: 1_000, executionId: "execution-a" },
  );
  const reclaimedAt = new Date(now.getTime() + 2_000);
  const second = await reserveGcpBudget(
    db,
    "owner-a",
    "run:job",
    0.006,
    config(),
    projectId,
    { now: reclaimedAt, leaseMs: 1_000, executionId: "execution-b" },
  );

  const oldClaimError = await assertRejects(() =>
    beginGcpBudgetExecution(db, first, reclaimedAt)
  );
  assertInstanceOf(oldClaimError, GcpBudgetExecutionLeaseLostError);
  await beginGcpBudgetExecution(
    db,
    second,
    new Date(reclaimedAt.getTime() + 100),
  );
  assertEquals(ledger(fake).grossReservedUsd, 0.006);
});

Deno.test("a revisionless legacy month accepts its first v2 reservation", async () => {
  const fake = new FakeDb();
  const db = fake as unknown as Db;
  fake.data.set("gcp_usage_months", [{
    _id: `${projectId}:2026-08`,
    projectId,
    month: "2026-08",
    grossReservedUsd: 0,
    grossCommittedUsd: 0,
    days: {},
  }]);

  const claim = await reserveGcpBudget(
    db,
    "owner-a",
    "revisionless:job",
    0.006,
    config(),
    projectId,
    { now, executionId: "execution-a" },
  );
  assertEquals(claim?.attemptId, "revisionless:job");
  assertEquals(ledger(fake).revision, 1);
  assertEquals(ledger(fake).grossReservedUsd, 0.006);
  assertEquals(ledger(fake).days["2026-08-22"].grossUsd, 0.006);
});

Deno.test("a reserving crash with a durable ledger marker releases exactly once", async () => {
  const fake = new FakeDb();
  const db = fake as unknown as Db;
  const ledgerId = `${projectId}:2026-08`;
  fake.data.set("gcp_usage_months", [{
    _id: ledgerId,
    projectId,
    month: "2026-08",
    revision: 1,
    grossReservedUsd: 0.006,
    grossCommittedUsd: 0,
    days: { "2026-08-22": { grossUsd: 0.006 } },
    reservationAttemptIds: ["reserving-crash:job"],
  }]);
  fake.data.set("gcp_usage_events", [{
    attemptId: "reserving-crash:job",
    principal: "owner-a",
    projectId,
    ledgerId,
    month: "2026-08",
    day: "2026-08-22",
    state: "reserving",
    grossListPriceUsd: 0.006,
    accountingVersion: 2,
  }]);

  assertEquals(
    await releaseUnstartedGcpBudgetAttempt(
      db,
      "reserving-crash:job",
      now,
    ),
    "released",
  );
  assertEquals(
    await releaseUnstartedGcpBudgetAttempt(
      db,
      "reserving-crash:job",
      now,
    ),
    "released",
  );
  assertEquals(event(fake).state, "released");
  assertEquals(ledger(fake).grossReservedUsd, 0);
  assertEquals(ledger(fake).grossCommittedUsd, 0);
  assertEquals(ledger(fake).days["2026-08-22"].grossUsd, 0);
  assertEquals(ledger(fake).settlementAttemptIds, ["reserving-crash:job"]);
});

Deno.test("a legacy reserved event is fail-closed until a ready run proves completion", async () => {
  const fake = new FakeDb();
  const db = fake as unknown as Db;
  const ledgerId = `${projectId}:2026-08`;
  fake.data.set("gcp_usage_months", [{
    _id: ledgerId,
    projectId,
    month: "2026-08",
    revision: 1,
    grossReservedUsd: 0.006,
    grossCommittedUsd: 0,
    days: { "2026-08-22": { grossUsd: 0.006 } },
  }]);
  fake.data.set("gcp_usage_events", [{
    attemptId: "legacy-run:job",
    principal: "owner-a",
    projectId,
    ledgerId,
    month: "2026-08",
    day: "2026-08-22",
    state: "reserved",
    grossListPriceUsd: 0.006,
  }]);

  await assertRejects(
    () =>
      reserveGcpBudget(
        db,
        "owner-a",
        "legacy-run:job",
        0.006,
        config(),
        projectId,
        { now },
      ),
    Error,
    "GCP_BUDGET_LEGACY_RESERVED_OUTCOME_UNKNOWN",
  );
  assertEquals(ledger(fake).reservationAttemptIds, undefined);

  assertEquals(
    await reconcileReadyGcpBudget(db, "legacy-run:job"),
    "committed",
  );
  assertEquals(event(fake).state, "committed");
  assertEquals(ledger(fake).grossReservedUsd, 0);
  assertEquals(ledger(fake).grossCommittedUsd, 0.006);
});

Deno.test("ready-run reconciliation commits a reservation left by a process crash", async () => {
  const fake = new FakeDb();
  const db = fake as unknown as Db;
  const claim = await reserveGcpBudget(
    db,
    "owner-a",
    "ready-run:job",
    0.006,
    config(),
    projectId,
    { now, executionId: "execution-a" },
  );
  await beginGcpBudgetExecution(db, claim, now);

  assertEquals(
    await reconcileReadyGcpBudget(db, claim!.attemptId),
    "committed",
  );
  assertEquals(event(fake).state, "committed");
  assertEquals(ledger(fake).grossReservedUsd, 0);
  assertEquals(ledger(fake).grossCommittedUsd, 0.006);
});

Deno.test("an unstarted claim can be released but a started call cannot", async () => {
  const releasedFake = new FakeDb();
  const releasedDb = releasedFake as unknown as Db;
  const unstarted = await reserveGcpBudget(
    releasedDb,
    "owner-a",
    "unstarted:job",
    0.006,
    config(),
    projectId,
    { now, executionId: "execution-a" },
  );
  assertEquals(
    await finishGcpBudget(releasedDb, unstarted, "released"),
    "released",
  );
  assertEquals(ledger(releasedFake).grossReservedUsd, 0);
  assertEquals(ledger(releasedFake).grossCommittedUsd, 0);
  assertEquals(
    ledger(releasedFake).days["2026-08-22"].grossUsd,
    0,
  );

  const startedFake = new FakeDb();
  const startedDb = startedFake as unknown as Db;
  const started = await reserveGcpBudget(
    startedDb,
    "owner-a",
    "started:job",
    0.006,
    config(),
    projectId,
    { now, executionId: "execution-b" },
  );
  await beginGcpBudgetExecution(startedDb, started, now);
  const error = await assertRejects(() =>
    finishGcpBudget(startedDb, started, "released")
  );
  assertInstanceOf(error, GcpBudgetExecutionLeaseLostError);
  assertEquals(ledger(startedFake).grossReservedUsd, 0.006);
});

Deno.test("settlement retries do not double-apply after a crash", async () => {
  const fake = new FakeDb();
  const db = fake as unknown as Db;
  const claim = await reserveGcpBudget(
    db,
    "owner-a",
    "ready-run:job",
    0.006,
    config(),
    projectId,
    { now, executionId: "execution-a" },
  );
  await beginGcpBudgetExecution(db, claim, now);
  fake.controls.failEventFinalizationOnce = true;

  await assertRejects(
    () => finishGcpBudget(db, claim, "committed"),
    Error,
    "simulated process crash",
  );
  assertEquals(event(fake).state, "settling");
  assertEquals(ledger(fake).grossCommittedUsd, 0.006);

  assertEquals(
    await reconcileReadyGcpBudget(db, claim!.attemptId),
    "committed",
  );
  assertEquals(event(fake).state, "committed");
  assertEquals(ledger(fake).grossReservedUsd, 0);
  assertEquals(ledger(fake).grossCommittedUsd, 0.006);
  assertEquals(ledger(fake).settlementAttemptIds, ["ready-run:job"]);
});

Deno.test("released settlement refunds the daily cap exactly once after a crash", async () => {
  const fake = new FakeDb();
  const db = fake as unknown as Db;
  const claim = await reserveGcpBudget(
    db,
    "owner-a",
    "cancelled-before-provider:job",
    0.006,
    config(),
    projectId,
    { now, executionId: "execution-a" },
  );
  fake.controls.failEventFinalizationOnce = true;

  await assertRejects(
    () => finishGcpBudget(db, claim, "released"),
    Error,
    "simulated process crash",
  );
  assertEquals(event(fake).state, "settling");
  assertEquals(ledger(fake).grossReservedUsd, 0);
  assertEquals(ledger(fake).days["2026-08-22"].grossUsd, 0);

  assertEquals(await finishGcpBudget(db, claim, "released"), "released");
  assertEquals(event(fake).state, "released");
  assertEquals(ledger(fake).grossReservedUsd, 0);
  assertEquals(ledger(fake).days["2026-08-22"].grossUsd, 0);
});

Deno.test("deterministic media run claim fences concurrent and stale provider calls", async () => {
  const fake = new FakeDb();
  const db = fake as unknown as Db;
  const first = await claimMediaAnalysisRun(
    db,
    { runId: "deterministic-run", jobId: "job-a", initial: { assetId: "a" } },
    { now, leaseMs: 1_000, claimId: "claim-a" },
  );
  if (first.kind !== "claimed") throw new Error("expected first claim");

  const concurrent = await claimMediaAnalysisRun(
    db,
    { runId: "deterministic-run", jobId: "job-b", initial: { assetId: "a" } },
    { now, leaseMs: 1_000, claimId: "claim-b" },
  );
  assertEquals(concurrent.kind, "busy");
  if (concurrent.kind === "busy") assertEquals(concurrent.reason, "active");

  const reclaimedAt = new Date(now.getTime() + 2_000);
  const reclaimed = await claimMediaAnalysisRun(
    db,
    { runId: "deterministic-run", jobId: "job-b", initial: { assetId: "a" } },
    { now: reclaimedAt, leaseMs: 1_000, claimId: "claim-b" },
  );
  if (reclaimed.kind !== "claimed") throw new Error("expected stale reclaim");
  const fenced = await assertRejects(() =>
    markMediaRunProviderStarted(db, first.claim, reclaimedAt)
  );
  assertInstanceOf(fenced, MediaRunClaimLostError);

  await markMediaRunProviderStarted(
    db,
    reclaimed.claim,
    new Date(reclaimedAt.getTime() + 100),
  );
  const staleStarted = await claimMediaAnalysisRun(
    db,
    { runId: "deterministic-run", jobId: "job-c", initial: { assetId: "a" } },
    {
      now: new Date(reclaimedAt.getTime() + 2_000),
      claimId: "claim-c",
    },
  );
  assertEquals(staleStarted.kind, "busy");
  if (staleStarted.kind === "busy") {
    assertEquals(staleStarted.reason, "provider_outcome_unknown");
  }

  await markMediaRunReady(db, reclaimed.claim, { usage: { calls: 1 } });
  const ready = await claimMediaAnalysisRun(
    db,
    { runId: "deterministic-run", jobId: "job-c", initial: { assetId: "a" } },
  );
  assertEquals(ready.kind, "ready");
});

Deno.test("media run ready and failed transitions are fenced by claim id", async () => {
  const fake = new FakeDb();
  const db = fake as unknown as Db;
  const first = await claimMediaAnalysisRun(
    db,
    { runId: "failed-run", jobId: "job-a", initial: { assetId: "a" } },
    { now, leaseMs: 1_000, claimId: "claim-a" },
  );
  if (first.kind !== "claimed") throw new Error("expected first claim");
  const second = await claimMediaAnalysisRun(
    db,
    { runId: "failed-run", jobId: "job-b", initial: { assetId: "a" } },
    {
      now: new Date(now.getTime() + 2_000),
      leaseMs: 1_000,
      claimId: "claim-b",
    },
  );
  if (second.kind !== "claimed") throw new Error("expected second claim");

  const oldFailure = await assertRejects(() =>
    markMediaRunFailed(db, first.claim, "old worker failed")
  );
  assertInstanceOf(oldFailure, MediaRunClaimLostError);
  await markMediaRunFailed(db, second.claim, "provider failed");

  const retry = await claimMediaAnalysisRun(
    db,
    { runId: "failed-run", jobId: "job-c", initial: { assetId: "a" } },
    { claimId: "claim-c" },
  );
  assertEquals(retry.kind, "claimed");
});

Deno.test("a post-start provider outcome is never reclaimed automatically", async () => {
  const fake = new FakeDb();
  const db = fake as unknown as Db;
  const first = await claimMediaAnalysisRun(
    db,
    { runId: "unknown-run", jobId: "job-a", initial: { assetId: "a" } },
    { now, leaseMs: 1_000, claimId: "claim-a" },
  );
  if (first.kind !== "claimed") throw new Error("expected first claim");

  await markMediaRunProviderStarted(db, first.claim, now);
  await markMediaRunOutcomeUnknown(
    db,
    first.claim,
    "provider response may have been billed",
    now,
  );

  const retry = await claimMediaAnalysisRun(
    db,
    { runId: "unknown-run", jobId: "job-b", initial: { assetId: "a" } },
    { now: new Date(now.getTime() + 60_000), claimId: "claim-b" },
  );
  assertEquals(retry.kind, "busy");
  if (retry.kind === "busy") {
    assertEquals(retry.reason, "provider_outcome_unknown");
    assertEquals(retry.run.state, "provider_outcome_unknown");
  }
});
