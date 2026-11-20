import { expect } from "@std/expect";
import { partitionTranscriptionsForPrompt } from "@/lib/extraction/shared.ts";
import capability, {
  buildConversationChunkClaimQuery,
  buildConversationChunkClaimRequest,
  mergedResponseSchema,
  parseMergedResponse,
  schema,
} from "./conversationExtractorMerged.ts";

const CHUNK_START = new Date("2026-08-01T10:00:00.000Z");
const CHUNK_END = new Date("2026-08-01T11:00:00.000Z");
const PROMPT_LINES = [
  "[time: 2026-08-01T10:00:00.000Z]",
  "First topic starts here",
  "[time: 2026-08-01T10:20:00.000Z]",
  "First topic ends here",
  "[time: 2026-08-01T10:30:00.000Z]",
  "Second topic starts here",
  "[time: 2026-08-01T10:55:00.000Z]",
];

Deno.test("merged extraction ends a conversation at the selected ASR utterance before a short pause", () => {
  const [window] = partitionTranscriptionsForPrompt([{
    start: CHUNK_START,
    end: CHUNK_END,
    segments: [
      { start: 0, end: 12.3, text: "First line\nlast words" },
      { start: 40, end: 69.98, text: "Next topic" },
    ],
  }]);
  const promptLines = window.prompt.split("\n");
  const lastWords = promptLines.indexOf("last words");
  const segments = parseMergedResponse(
    JSON.stringify({
      segments: [
        { title: "First", start: "First line", end: "last words" },
        { title: "By line", start: lastWords, end: lastWords },
        { title: "Next", start: "Next topic", end: "Next topic" },
      ],
    }),
    promptLines,
    window.start,
    window.end,
    new Set(),
    window.utterancesByLine,
  );
  expect(segments.map(({ start, end }) => [
    start.getTime() - CHUNK_START.getTime(),
    end.getTime() - CHUNK_START.getTime(),
  ])).toEqual([[0, 12_300], [0, 12_300], [40_000, 69_980]]);
});

Deno.test("merged extractor defaults and schema", () => {
  const input = schema.parse({ type: "conversation_extractor_merged" });
  expect(input.limit).toBe(1);
  expect(input.force).toBe(false);
  expect(input.maxTokens).toBe(8192);
  expect(input.maxPromptChars).toBe(32_000);
  expect(input.merged_system_prompt).toContain("segments");
  expect(input.merged_system_prompt).toContain("entities");

  expect(() =>
    schema.parse({ type: "conversation_extractor_merged", force: true })
  ).toThrow("force requires an explicit chunkId");

  expect(
    mergedResponseSchema.safeParse({
      segments: [{
        title: "T",
        start: "s",
        end: "e",
        emoji: "🧠",
        agreed_upon_something: false,
        entities: [{ name: "X", type: "person" }],
        tags: [],
      }],
    }).success,
  ).toBe(true);
});

Deno.test("merged extractor shares retry and stale claim eligibility", () => {
  const now = new Date("2026-08-15T04:00:00.000Z");
  expect(buildConversationChunkClaimQuery({}, now)).toEqual({
    $or: [
      { state: "ready" },
      { state: "error", extractionRetryAfter: { $lte: now } },
      { state: "error", extractionRetryAfter: { $exists: false } },
      {
        state: "processing",
        processingStartedAt: {
          $lt: new Date("2026-08-15T03:50:00.000Z"),
        },
      },
    ],
  });

  const retryNow = buildConversationChunkClaimQuery({ retryNow: true }, now);
  expect((retryNow.$or as any[])[1]).toEqual({ state: "error" });
});

Deno.test("merged extractor atomically claims the newest eligible chunk", () => {
  const now = new Date("2026-08-15T04:00:00.000Z");
  const request = buildConversationChunkClaimRequest(
    {
      start: new Date("2026-08-01T00:00:00.000Z"),
      end: new Date("2026-08-02T00:00:00.000Z"),
    },
    "extractor-job-1",
    now,
  ) as any;

  expect(request.action).toBe("findOneAndUpdate");
  expect(request.collection).toBe("conversation_chunks");
  expect(request.options).toEqual({
    sort: { start: -1 },
    returnDocument: "before",
  });
  expect(request.query.start).toEqual({
    $gte: new Date("2026-08-01T00:00:00.000Z"),
    $lt: new Date("2026-08-02T00:00:00.000Z"),
  });
  expect(request.update.$set).toEqual({
    state: "processing",
    processingStartedAt: now,
    processedByJobId: "extractor-job-1",
  });
});

Deno.test("merged extractor pending work allows runtime concurrency fan-out", async () => {
  const calls: any[] = [];
  const pending = await capability.hasPendingWork!({
    reason: "test",
    mongo: async (input: any) => {
      calls.push(input);
      return [{ _id: "ready-chunk" }];
    },
  });

  expect(pending).toBe(true);
  expect(typeof pending).toBe("boolean");
  expect(calls).toHaveLength(1);
  expect(calls[0].options).toMatchObject({
    projection: { _id: 1 },
    limit: 1,
  });
});

Deno.test("merged response parses segments with metadata and boundaries", () => {
  const content = JSON.stringify({
    segments: [
      {
        title: "First topic",
        start: "First topic starts here",
        end: "First topic ends here",
        emoji: "💡 idea",
        agreed_upon_something: true,
        entities: [
          { name: "Шуши", type: "animal" },
          { name: " шуши ", type: "person" },
          { name: "AI", type: "concept" },
        ],
        tags: ["work", "hallucinated"],
      },
    ],
  });

  const segments = parseMergedResponse(
    content,
    PROMPT_LINES,
    CHUNK_START,
    CHUNK_END,
    new Set(["work", "family"]),
  );

  expect(segments).toHaveLength(1);
  const seg = segments[0];
  expect(seg.title).toBe("First topic");
  expect(seg.start).toEqual(new Date("2026-08-01T10:00:00.000Z"));
  expect(seg.end).toEqual(new Date("2026-08-01T10:30:00.000Z"));
  expect(seg.emoji).toBe("💡");
  expect(seg.agreed_upon_something).toBe(true);
  expect(seg.entities).toEqual([
    { name: "Шуши", type: "animal" },
    { name: "AI", type: "concept" },
  ]);
  expect(seg.droppedEntities).toBe(1); // case-insensitive duplicate
  expect(seg.tags).toEqual(["work"]);
  expect(seg.droppedTags).toBe(1); // unknown tag name
});

Deno.test("merged response records invalid emoji and unknown types", () => {
  const content = JSON.stringify({
    segments: [{
      title: "",
      start: "Second topic starts here",
      end: "nonexistent phrase",
      emoji: "none",
      agreed_upon_something: "yes",
      entities: [{ name: "Толя", type: "sandwich" }],
      tags: [],
    }],
  });

  const segments = parseMergedResponse(
    content,
    PROMPT_LINES,
    CHUNK_START,
    CHUNK_END,
    new Set(),
  );

  expect(segments).toHaveLength(1);
  const seg = segments[0];
  expect(seg.title).toBe("Conversation 1"); // empty title fallback
  expect(seg.emoji).toBeUndefined();
  expect(Boolean(seg.emoji)).toBe(false);
  expect(seg.rawEmoji).toBe("none");
  expect(seg.entities).toEqual([{ name: "Толя", type: "other" }]);
});

Deno.test("merged response with no segments yields empty list", () => {
  expect(
    parseMergedResponse(
      JSON.stringify({ segments: [] }),
      PROMPT_LINES,
      CHUNK_START,
      CHUNK_END,
      new Set(),
    ),
  ).toEqual([]);
});
