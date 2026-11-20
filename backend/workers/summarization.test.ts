import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import type { Job } from "bullmq";
import { EJSON } from "bson";
import { z } from "zod";
import type { JobData } from "@/lib/jobs/types.ts";
import {
  buildSummarizationPendingQuery,
  buildSummarySourceRefs,
  getSummarizationRetryDelayMs,
  isTerminalSummarizationResponseError,
  parseSummaryTitleResponse,
  schema,
  selectSummaryUtterances,
  transcriptOnlyReason,
  use,
} from "./summarization.ts";

Deno.test("summary prompt and receipt use only speech overlapping the requested recording", async () => {
  const time = (sec: number) => new Date(Date.UTC(2026, 0, 1) + sec * 1000);
  const start = time(0);
  const end = time(40);
  const records = [
    { _id: "left", start: time(-5), end: start, text: "Left." },
    {
      _id: "credit",
      start,
      end,
      segments: [
        { start: 0, end: 40, text: "Субтитры делал DimaTorzok." },
      ],
    },
    {
      _id: "overlap",
      start: time(-5),
      end: time(43),
      segments: [
        { start: 0, end: 5, text: "Before." },
        { start: 16, end: 17, text: "Что?" },
        { start: 45, end: 48, text: "After." },
      ],
    },
    { _id: "right", start: end, end: time(60), text: "Right." },
  ];
  let writes = 0;
  using _fetch = stub(globalThis, "fetch", (_request, init) => {
    const body = EJSON.parse(String(init?.body));
    if (body.action === "find" && body.collection === "transcriptions") {
      expect(body.query).toEqual({ start: { $lt: end }, end: { $gt: start } });
      return Promise.resolve(new Response(EJSON.stringify(records)));
    }
    expect(body.action).toBe("create");
    const entry = body.object.summaries[0];
    expect(entry.modelName).toBe("transcript-only");
    expect(entry.text).toBe(
      `[${time(11).toISOString()}]\nЧто?\n[${time(12).toISOString()}]`,
    );
    expect(entry.sourceRefs.transcriptionIds).toEqual(["overlap"]);
    expect(entry.sourceRefs.coverageStart).toBe(start.toISOString());
    expect(entry.sourceRefs.coverageEnd).toBe(end.toISOString());
    writes++;
    return Promise.resolve(
      new Response(EJSON.stringify({ insertedId: "object" })),
    );
  });
  const data = schema.parse({ type: "summarization", start, end });
  const result = await use({ id: "test", data } as unknown as Job<JobData>);
  expect(result.success).toBe(true);
  expect(writes).toBe(1);
});

Deno.test("an existing conversation without usable text gets a retry time and makes no inference call", async () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const end = new Date(start.getTime() + 40_000);
  const id = "65b000000000000000000000";
  let failureSaved = false;
  using _fetch = stub(globalThis, "fetch", (_request, init) => {
    const body = EJSON.parse(String(init?.body));
    if (body.action === "get") {
      return Promise.resolve(
        Response.json({ _id: id, version: 1, timeRanges: [{ start, end }] }),
      );
    }
    if (body.action === "find") {
      return Promise.resolve(
        Response.json([{ start, end, text: "Субтитры делал DimaTorzok." }]),
      );
    }
    expect(body.action).toBe("update");
    expect(body.field).toBe("_summarizationFailure");
    expect(body.value.code).toBe("NO_TRANSCRIPT_TEXT");
    expect(Date.parse(body.value.retryAfter) - Date.parse(body.value.failedAt))
      .toBe(15 * 60_000);
    failureSaved = true;
    return Promise.resolve(Response.json({}));
  });
  const data = schema.parse({ type: "summarization", objectId: id });
  await expect(use({ id: "test", data } as unknown as Job<JobData>)).rejects
    .toThrow(
      "No usable transcript text in range",
    );
  expect(failureSaved).toBe(true);
});

Deno.test("summary selection clips crossing segments and requires containment for untimed legacy text", () => {
  const time = (sec: number) => new Date(sec * 1000);
  const docs = [
    {
      _id: "cut",
      start: time(0),
      end: time(100),
      segments: [
        { text: "No timestamp" },
        { start: 3, end: 8, text: "Crosses start" },
        { start: 12, end: 20, text: "Crosses end" },
      ],
    },
    { _id: "whole", start: time(8), end: time(11), text: "Legacy text" },
    { _id: "partial", start: time(4), end: time(12), text: "Uncertain" },
    {
      _id: "legacy-credit",
      start: time(8),
      end: time(11),
      text: "Субтитры сделал DimaTorzok",
    },
  ];
  expect(selectSummaryUtterances(docs, time(5), time(15))).toEqual([
    { _id: "cut", start: 5000, end: 8000, text: "Crosses start" },
    { _id: "whole", start: 8000, end: 11000, text: "Legacy text" },
    { _id: "cut", start: 12000, end: 15000, text: "Crosses end" },
  ]);
});

Deno.test("summary uses passthrough only for one short utterance or the configured short duration", () => {
  const utterance = { start: 1000, end: 2000, text: "Когда это было?" };
  expect(transcriptOnlyReason([utterance], 40, 10)).toContain(
    "Single brief utterance",
  );
  expect(transcriptOnlyReason([utterance], 40, 0)).toBeNull();
  expect(transcriptOnlyReason([utterance, utterance], 40, 10)).toBeNull();
  expect(
    transcriptOnlyReason([{ ...utterance, text: "Это было в среду." }], 40, 10),
  ).toBeNull();
  expect(transcriptOnlyReason([utterance, utterance], 5, 10)).toContain(
    "Short duration",
  );
});

Deno.test("summary pending query includes due failures and stale claims", () => {
  const now = new Date("2026-08-15T04:00:00.000Z");
  const query = buildSummarizationPendingQuery({
    now,
    claimStaleMs: 10 * 60 * 1000,
  }) as any;

  expect(query["summaries.0.date"]).toEqual({ $exists: false });
  expect(query.$and[0].$or[2]).toEqual({
    "_summarizationClaim.startedAt": {
      $lte: "2026-08-15T03:50:00.000Z",
    },
  });
  expect(query.$or[2]).toEqual({
    "_summarizationFailure.retryAfter": {
      $lte: "2026-08-15T04:00:00.000Z",
    },
  });
});

Deno.test("summarization schema defaults and bounds batchSize", () => {
  const parsed = schema.parse({ type: "summarization" });
  expect(parsed.batchSize).toBe(25);

  expect(schema.safeParse({ type: "summarization", batchSize: 0 }).success)
    .toBe(false);
  expect(schema.safeParse({ type: "summarization", batchSize: 101 }).success)
    .toBe(false);

  // The Jobs page batch column auto-detects workers by these JSON schema
  // properties — guard the contract.
  const json = z.toJSONSchema(schema) as {
    properties: Record<string, Record<string, unknown>>;
  };
  expect(json.properties.batchSize.type).toBe("integer");
  expect(json.properties.batchSize.minimum).toBe(1);
  expect(json.properties.batchSize.maximum).toBe(100);
  expect(json.properties.batchSize.default).toBe(25);
});

Deno.test("combined summary+title response parses JSON and fenced JSON", () => {
  expect(parseSummaryTitleResponse(
    JSON.stringify({ summary: "We talked about cats.", title: ' "Cats" ' }),
  )).toEqual({ summary: "We talked about cats.", title: "Cats" });

  expect(parseSummaryTitleResponse(
    '```json\n{"summary": "S", "title": "T"}\n```',
  )).toEqual({ summary: "S", title: "T" });
});

Deno.test("combined summary+title response falls back on plain text", () => {
  // Model ignored the JSON contract → caller uses the whole text as summary.
  expect(parseSummaryTitleResponse("Just a plain summary.")).toBeNull();
  expect(parseSummaryTitleResponse('{"summary": "only summary"}')).toBeNull();
  expect(parseSummaryTitleResponse('{"title": "only title"}')).toBeNull();
});

Deno.test("summarization retries back off and remain bounded", () => {
  expect(getSummarizationRetryDelayMs(1)).toBe(15 * 60 * 1000);
  expect(getSummarizationRetryDelayMs(2)).toBe(30 * 60 * 1000);
  expect(getSummarizationRetryDelayMs(99)).toBe(24 * 60 * 60 * 1000);
});

Deno.test("summary source receipt records exact chunks and transcripts", () => {
  const refs = buildSummarySourceRefs(
    [
      { _id: "transcription-1" },
      { _id: { toString: () => "transcription-2" } },
      { _id: "transcription-1" },
    ],
    new Date("2026-07-28T10:00:00.000Z"),
    new Date("2026-07-28T10:05:00.000Z"),
    {
      conversationId: "conversation-1",
      conversationChunkIds: ["chunk-1", "chunk-1"],
      extractorJobId: "extractor-job-1",
    },
  );

  expect(refs).toEqual({
    schemaVersion: "v1",
    selection: "time_range_overlap",
    conversationId: "conversation-1",
    conversationChunkIds: ["chunk-1"],
    transcriptionIds: ["transcription-1", "transcription-2"],
    coverageStart: "2026-07-28T10:00:00.000Z",
    coverageEnd: "2026-07-28T10:05:00.000Z",
    extractorJobId: "extractor-job-1",
  });
});

Deno.test("terminal completion responses are quarantined", () => {
  expect(isTerminalSummarizationResponseError(
    'LLM_INVALID_RESPONSE: finish_reason: "content_filter: PROHIBITED_CONTENT"',
  ))
    .toBe(true);
  expect(isTerminalSummarizationResponseError(
    "LLM_EMPTY_RESPONSE: blocked by safety policy",
  ))
    .toBe(true);
});

Deno.test("provider-wide response and transport failures remain retryable", () => {
  expect(isTerminalSummarizationResponseError("LLM_INVALID_RESPONSE: bad"))
    .toBe(false);
  expect(isTerminalSummarizationResponseError("LLM_EMPTY_RESPONSE: empty"))
    .toBe(false);
  expect(isTerminalSummarizationResponseError("LLM API error (502)"))
    .toBe(false);
  expect(isTerminalSummarizationResponseError("connection refused"))
    .toBe(false);
});

Deno.test("hasPendingWork reports jobs worth starting, not just a boolean", async () => {
  const capability = (await import("./summarization.ts")).default;
  const calls: any[] = [];
  const fakeMongo = (pending: number, batchSize?: number) => (input: any) => {
    calls.push(input);
    if (input.action === "count") return Promise.resolve(pending);
    if (input.action === "findOne" && input.collection === "workers") {
      return Promise.resolve(
        batchSize === undefined ? null : { defaultOverrides: { batchSize } },
      );
    }
    return Promise.resolve(null);
  };

  // Empty queue: 0 jobs, and the workers collection is not even consulted.
  calls.length = 0;
  expect(
    await capability.hasPendingWork!({
      mongo: fakeMongo(0),
      reason: "test",
    }),
  ).toBe(0);
  expect(calls.length).toBe(1);
  // The count must use the indexed subfield predicate.
  expect(calls[0].query["summaries.0.date"]).toEqual({ $exists: false });
  expect(calls[0].query.isConversation).toBe(true);

  // Backlog splits into ceil(pending / batchSize) jobs.
  expect(
    await capability.hasPendingWork!({
      mongo: fakeMongo(25, 10),
      reason: "test",
    }),
  ).toBe(3);

  // No operator override falls back to the schema default batch of 25.
  expect(
    await capability.hasPendingWork!({
      mongo: fakeMongo(26),
      reason: "test",
    }),
  ).toBe(2);

  // A single stray conversation still yields exactly one job.
  expect(
    await capability.hasPendingWork!({
      mongo: fakeMongo(1, 10),
      reason: "test",
    }),
  ).toBe(1);
});
