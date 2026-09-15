import type { Db } from "mongodb";
import type { MediaKnowledgeConfig } from "@myceliasdk/media.ts";
import { randomUUID } from "node:crypto";
import { gcpUsageLedgerId } from "./costs.ts";
import { assertPromoGuard } from "./promo-guard.ts";

const GCP_BUDGET_ACCOUNTING_VERSION = 2;
export const GCP_BUDGET_EXECUTION_LEASE_MS = 5 * 60 * 1000;

type GcpBudgetFinalState = "committed" | "unknown" | "released";
type GcpBudgetEventState =
  | "reserving"
  | "reserved"
  | "settling"
  | GcpBudgetFinalState;

type GcpBudgetEvent = {
  attemptId: string;
  principal: string;
  projectId: string;
  ledgerId: string;
  month: string;
  day: string;
  state: GcpBudgetEventState;
  targetState?: GcpBudgetFinalState;
  grossListPriceUsd: number;
  accountingVersion?: number;
  execution?: {
    id: string;
    state: "claimed" | "started";
    claimedAt: Date;
    leaseExpiresAt: Date;
    startedAt?: Date;
  };
};

type GcpBudgetMonth = {
  _id: string;
  revision?: number;
  grossCommittedUsd?: number;
  grossReservedUsd?: number;
  days?: Record<string, { grossUsd?: number }>;
  reservationAttemptIds?: string[];
  settlementAttemptIds?: string[];
};

export type GcpBudgetExecutionClaim = {
  attemptId: string;
  executionId: string;
  leaseExpiresAt: Date;
};

export class GcpBudgetAttemptBusyError extends Error {
  constructor(message = "GCP_BUDGET_ATTEMPT_IN_PROGRESS") {
    super(message);
    this.name = "GcpBudgetAttemptBusyError";
  }
}

export class GcpBudgetExecutionLeaseLostError extends Error {
  constructor(message = "GCP_BUDGET_EXECUTION_LEASE_LOST") {
    super(message);
    this.name = "GcpBudgetExecutionLeaseLostError";
  }
}

function positiveFinite(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("GCP_BUDGET_EVENT_AMOUNT_INVALID");
  }
  return parsed;
}

function includesAttempt(value: unknown, attemptId: string): boolean {
  return Array.isArray(value) && value.includes(attemptId);
}

function assertMatchingEvent(
  event: GcpBudgetEvent,
  expected: {
    attemptId: string;
    principal: string;
    projectId: string;
    ledgerId: string;
    month: string;
    day: string;
    amount: number;
  },
): void {
  if (
    event.attemptId !== expected.attemptId ||
    event.principal !== expected.principal ||
    event.projectId !== expected.projectId ||
    event.ledgerId !== expected.ledgerId ||
    event.month !== expected.month ||
    event.day !== expected.day ||
    Number(event.grossListPriceUsd) !== expected.amount
  ) {
    throw new Error("GCP_BUDGET_ATTEMPT_METADATA_MISMATCH");
  }
}

async function reserveLedgerOnce(
  db: Db,
  event: GcpBudgetEvent,
  config: MediaKnowledgeConfig,
  now: Date,
): Promise<void> {
  const collection = db.collection<GcpBudgetMonth>("gcp_usage_months");
  const amount = positiveFinite(event.grossListPriceUsd);

  for (let tries = 0; tries < 8; tries++) {
    const current = await collection.findOne({ _id: event.ledgerId });
    if (
      includesAttempt(current?.reservationAttemptIds, event.attemptId) ||
      includesAttempt(current?.settlementAttemptIds, event.attemptId)
    ) return;

    const revision = Number(current?.revision ?? 0);
    const monthUsed = Number(current?.grossCommittedUsd ?? 0) +
      Number(current?.grossReservedUsd ?? 0);
    const dayUsed = Number(current?.days?.[event.day]?.grossUsd ?? 0);
    if (monthUsed + amount > Number(config.promoGuard.verifiedRemainingUsd)) {
      throw new Error("GCP_VERIFIED_PROMO_BALANCE_BLOCKED");
    }
    if (monthUsed + amount > config.promoGuard.monthlyGrossLimitUsd) {
      throw new Error("GCP_MONTHLY_BUDGET_BLOCKED");
    }
    if (
      config.promoGuard.dailyGrossLimitUsd !== null &&
      dayUsed + amount > config.promoGuard.dailyGrossLimitUsd
    ) {
      throw new Error("GCP_DAILY_BUDGET_BLOCKED");
    }

    const update = {
      $setOnInsert: {
        owner: `gcp-project:${event.projectId}`,
        projectId: event.projectId,
        month: event.month,
        grossCommittedUsd: 0,
        createdAt: now,
      },
      $inc: {
        grossReservedUsd: amount,
        [`days.${event.day}.grossUsd`]: amount,
        revision: 1,
      },
      $addToSet: { reservationAttemptIds: event.attemptId },
      $set: { updatedAt: now },
    };
    try {
      const result = current
        ? await collection.updateOne(
          {
            _id: event.ledgerId,
            ...(current.revision === undefined
              ? {
                $or: [
                  { revision: { $exists: false } },
                  { revision: 0 },
                ],
              }
              : { revision }),
            reservationAttemptIds: { $ne: event.attemptId },
            settlementAttemptIds: { $ne: event.attemptId },
          },
          update,
        )
        : await collection.updateOne(
          { _id: event.ledgerId },
          update,
          { upsert: true },
        );
      if (result.modifiedCount === 1 || result.upsertedCount === 1) return;
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) continue;
      throw error;
    }
  }
  throw new Error("GCP_BUDGET_RESERVATION_BUSY");
}

async function adoptLegacyReservationMarker(
  db: Db,
  event: GcpBudgetEvent,
): Promise<void> {
  const result = await db.collection<GcpBudgetMonth>("gcp_usage_months")
    .updateOne(
      { _id: event.ledgerId },
      {
        $addToSet: { reservationAttemptIds: event.attemptId },
        $set: { updatedAt: new Date() },
      },
    );
  if (result.matchedCount !== 1) {
    throw new Error("GCP_BUDGET_LEDGER_NOT_FOUND");
  }
}

/**
 * Atomically reserves budget and grants exactly one short-lived permission to
 * start the external request. A duplicate caller never inherits the original
 * caller's reservation as permission to call Google.
 */
export async function reserveGcpBudget(
  db: Db,
  principal: string,
  attemptId: string,
  amount: number,
  config: MediaKnowledgeConfig,
  projectId: string,
  options: { now?: Date; leaseMs?: number; executionId?: string } = {},
): Promise<GcpBudgetExecutionClaim | null> {
  if (amount <= 0) return null;
  const now = options.now ?? new Date();
  assertPromoGuard(config, projectId, amount, now.getTime());
  const month = now.toISOString().slice(0, 7);
  const day = now.toISOString().slice(0, 10);
  const ledgerId = gcpUsageLedgerId(projectId, month);
  const events = db.collection<GcpBudgetEvent>("gcp_usage_events");
  const expected = {
    attemptId,
    principal,
    projectId,
    ledgerId,
    month,
    day,
    amount: positiveFinite(amount),
  };
  let inserted = false;
  try {
    await events.insertOne({
      attemptId,
      principal,
      projectId,
      ledgerId,
      month,
      day,
      state: "reserving",
      grossListPriceUsd: amount,
      accountingVersion: GCP_BUDGET_ACCOUNTING_VERSION,
      createdAt: now,
      updatedAt: now,
    } as GcpBudgetEvent);
    inserted = true;
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
  }

  const event = await events.findOne({ attemptId });
  if (!event) throw new Error("GCP_BUDGET_ATTEMPT_NOT_FOUND");
  assertMatchingEvent(event, expected);
  if (["committed", "unknown", "released", "settling"].includes(event.state)) {
    throw new Error("GCP_BUDGET_ATTEMPT_ALREADY_SETTLED");
  }

  try {
    if (event.accountingVersion === GCP_BUDGET_ACCOUNTING_VERSION) {
      await reserveLedgerOnce(db, event, config, now);
    } else {
      // In v1 `reserved` covered both the pre-call and in-flight/returned
      // phases. Without a durable start fence it is unsafe to grant a new
      // execution claim. A ready run may still reconcile it as committed.
      throw new Error("GCP_BUDGET_LEGACY_RESERVED_OUTCOME_UNKNOWN");
    }
  } catch (error) {
    // A Mongo write can succeed server-side while the driver reports an
    // uncertain network result. Never delete the event if the idempotency
    // marker proves that the reservation was applied.
    const ledger = await db.collection<GcpBudgetMonth>("gcp_usage_months")
      .findOne({ _id: event.ledgerId })
      .catch(() => null);
    if (
      event.accountingVersion === GCP_BUDGET_ACCOUNTING_VERSION &&
      includesAttempt(ledger?.reservationAttemptIds, attemptId)
    ) {
      // Continue to the execution claim; reserveLedgerOnce is idempotent.
    } else {
      if (inserted) {
        await events.deleteOne({
          attemptId,
          state: "reserving",
          accountingVersion: GCP_BUDGET_ACCOUNTING_VERSION,
        });
      }
      throw error;
    }
  }

  const executionId = options.executionId ?? randomUUID();
  const leaseExpiresAt = new Date(
    now.getTime() +
      Math.max(1_000, options.leaseMs ?? GCP_BUDGET_EXECUTION_LEASE_MS),
  );
  const claimed = await events.findOneAndUpdate(
    {
      attemptId,
      state: { $in: ["reserving", "reserved"] },
      $or: [
        { execution: { $exists: false } },
        {
          "execution.state": "claimed",
          "execution.leaseExpiresAt": { $lte: now },
        },
      ],
    },
    {
      $set: {
        state: "reserved",
        accountingVersion: GCP_BUDGET_ACCOUNTING_VERSION,
        execution: {
          id: executionId,
          state: "claimed",
          claimedAt: now,
          leaseExpiresAt,
        },
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  if (!claimed) throw new GcpBudgetAttemptBusyError();
  return { attemptId, executionId, leaseExpiresAt };
}

/** Marks the point after which a stale duplicate must never repeat the call. */
export async function beginGcpBudgetExecution(
  db: Db,
  claim: GcpBudgetExecutionClaim | null,
  now = new Date(),
): Promise<void> {
  if (!claim) return;
  const result = await db.collection<GcpBudgetEvent>("gcp_usage_events")
    .updateOne(
      {
        attemptId: claim.attemptId,
        state: "reserved",
        "execution.id": claim.executionId,
        "execution.state": "claimed",
        "execution.leaseExpiresAt": { $gt: now },
      },
      {
        $set: {
          "execution.state": "started",
          "execution.startedAt": now,
          updatedAt: now,
        },
      },
    );
  if (result.modifiedCount !== 1) {
    throw new GcpBudgetExecutionLeaseLostError();
  }
}

async function settleLedgerOnce(
  db: Db,
  event: GcpBudgetEvent,
  state: GcpBudgetFinalState,
  now: Date,
): Promise<void> {
  const amount = positiveFinite(event.grossListPriceUsd);
  const collection = db.collection<GcpBudgetMonth>("gcp_usage_months");
  const ledger = await collection.findOne({ _id: event.ledgerId });
  if (!ledger) throw new Error("GCP_BUDGET_LEDGER_NOT_FOUND");
  if (includesAttempt(ledger.settlementAttemptIds, event.attemptId)) return;
  if (!includesAttempt(ledger.reservationAttemptIds, event.attemptId)) {
    throw new Error("GCP_BUDGET_RESERVATION_MARKER_NOT_FOUND");
  }
  const increment = state === "released"
    ? {
      grossReservedUsd: -amount,
      [`days.${event.day}.grossUsd`]: -amount,
    }
    : { grossReservedUsd: -amount, grossCommittedUsd: amount };
  const result = await collection.updateOne(
    {
      _id: event.ledgerId,
      reservationAttemptIds: event.attemptId,
      settlementAttemptIds: { $ne: event.attemptId },
    },
    {
      $inc: increment,
      $addToSet: { settlementAttemptIds: event.attemptId },
      $set: { updatedAt: now },
    },
  );
  if (result.modifiedCount !== 1) {
    const current = await collection.findOne({ _id: event.ledgerId });
    if (!includesAttempt(current?.settlementAttemptIds, event.attemptId)) {
      throw new Error("GCP_BUDGET_SETTLEMENT_BUSY");
    }
  }
}

async function settleGcpBudget(
  db: Db,
  attemptId: string,
  requestedState: GcpBudgetFinalState,
  options: { executionId?: string; reconcileReady?: boolean; now?: Date } = {},
): Promise<GcpBudgetFinalState | null> {
  const events = db.collection<GcpBudgetEvent>("gcp_usage_events");
  const now = options.now ?? new Date();
  let event = await events.findOne({ attemptId });
  if (!event) return null;
  if (["committed", "unknown", "released"].includes(event.state)) {
    return event.state as GcpBudgetFinalState;
  }
  if (event.state === "reserving") {
    throw new Error("GCP_BUDGET_RESERVATION_NOT_FINISHED");
  }

  if (event.state === "reserved") {
    if (event.accountingVersion !== GCP_BUDGET_ACCOUNTING_VERSION) {
      await adoptLegacyReservationMarker(db, event);
    }
    const filter: Record<string, unknown> = { attemptId, state: "reserved" };
    if (!options.reconcileReady) {
      if (!options.executionId) {
        throw new GcpBudgetExecutionLeaseLostError();
      }
      filter["execution.id"] = options.executionId;
      // A claim may be released before the external request starts. Once the
      // started marker exists, only committed/unknown are safe outcomes.
      filter["execution.state"] = requestedState === "released"
        ? "claimed"
        : "started";
    }
    event = await events.findOneAndUpdate(
      filter,
      {
        $set: {
          state: "settling",
          targetState: requestedState,
          accountingVersion: GCP_BUDGET_ACCOUNTING_VERSION,
          settlingAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: "after" },
    ) ?? await events.findOne({ attemptId });
    if (!event) return null;
  }
  if (event.state !== "settling" || !event.targetState) {
    if (["committed", "unknown", "released"].includes(event.state)) {
      return event.state as GcpBudgetFinalState;
    }
    throw new GcpBudgetExecutionLeaseLostError();
  }

  // The first settlement target wins. In particular, a crash-recovery path
  // never changes a conservative `unknown` charge into `released`.
  const targetState = event.targetState;
  await settleLedgerOnce(db, event, targetState, now);
  await events.updateOne(
    { attemptId, state: "settling", targetState },
    {
      $set: { state: targetState, updatedAt: now },
      $unset: {
        targetState: "",
        settlingAt: "",
        execution: "",
      },
    },
  );
  return targetState;
}

export async function finishGcpBudget(
  db: Db,
  claim: GcpBudgetExecutionClaim | null,
  state: GcpBudgetFinalState,
): Promise<GcpBudgetFinalState | null> {
  if (!claim) return null;
  return await settleGcpBudget(db, claim.attemptId, state, {
    executionId: claim.executionId,
  });
}

/**
 * Releases a stale attempt for which the caller's own durable run fence proves
 * that provider execution never started. This also recovers the narrow crash
 * window between applying the month-ledger marker and publishing the normal
 * `reserved/execution.claimed` event state.
 */
export async function releaseUnstartedGcpBudgetAttempt(
  db: Db,
  attemptId: string | null | undefined,
  now = new Date(),
): Promise<GcpBudgetFinalState | null> {
  if (!attemptId) return null;
  const events = db.collection<GcpBudgetEvent>("gcp_usage_events");
  let event = await events.findOne({ attemptId });
  if (!event) return null;
  if (["committed", "unknown", "released"].includes(event.state)) {
    return event.state as GcpBudgetFinalState;
  }
  if (event.state === "settling") {
    return await settleGcpBudget(db, attemptId, "released", { now });
  }
  if (event.state === "reserved") {
    if (event.accountingVersion !== GCP_BUDGET_ACCOUNTING_VERSION) {
      throw new Error("GCP_BUDGET_LEGACY_RESERVED_OUTCOME_UNKNOWN");
    }
    if (event.execution?.state === "started") {
      throw new GcpBudgetExecutionLeaseLostError();
    }
    if (event.execution?.id) {
      return await settleGcpBudget(db, attemptId, "released", {
        executionId: event.execution.id,
        now,
      });
    }
    event = await events.findOneAndUpdate(
      {
        attemptId,
        state: "reserved",
        accountingVersion: GCP_BUDGET_ACCOUNTING_VERSION,
        execution: { $exists: false },
      },
      {
        $set: {
          state: "settling",
          targetState: "released",
          settlingAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: "after" },
    ) ?? await events.findOne({ attemptId });
    if (!event) return null;
    return await settleGcpBudget(db, attemptId, "released", { now });
  }
  if (event.state !== "reserving") {
    throw new GcpBudgetExecutionLeaseLostError();
  }
  if (event.accountingVersion !== GCP_BUDGET_ACCOUNTING_VERSION) {
    throw new Error("GCP_BUDGET_LEGACY_RESERVED_OUTCOME_UNKNOWN");
  }
  const ledger = await db.collection<GcpBudgetMonth>("gcp_usage_months")
    .findOne({ _id: event.ledgerId });
  const reservationApplied = includesAttempt(
    ledger?.reservationAttemptIds,
    attemptId,
  );
  if (!reservationApplied) {
    const released = await events.findOneAndUpdate(
      {
        attemptId,
        state: "reserving",
        accountingVersion: GCP_BUDGET_ACCOUNTING_VERSION,
      },
      {
        $set: { state: "released", updatedAt: now },
        $unset: { execution: "", targetState: "", settlingAt: "" },
      },
      { returnDocument: "after" },
    ) ?? await events.findOne({ attemptId });
    if (released?.state !== "released") {
      throw new GcpBudgetExecutionLeaseLostError();
    }
    return "released";
  }
  event = await events.findOneAndUpdate(
    {
      attemptId,
      state: "reserving",
      accountingVersion: GCP_BUDGET_ACCOUNTING_VERSION,
    },
    {
      $set: {
        state: "settling",
        targetState: "released",
        settlingAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  ) ?? await events.findOne({ attemptId });
  if (!event) return null;
  return await settleGcpBudget(db, attemptId, "released", { now });
}

/**
 * A ready analysis is durable proof that the provider result was accepted.
 * Reconcile its reservation before returning the reused result.
 */
export async function reconcileReadyGcpBudget(
  db: Db,
  attemptId: string | null | undefined,
): Promise<GcpBudgetFinalState | null> {
  if (!attemptId) return null;
  return await settleGcpBudget(db, attemptId, "committed", {
    reconcileReady: true,
  });
}
