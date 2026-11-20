import { expect } from "@std/expect";
import { buildJsonSchemaResponseFormat } from "../llm/worker-response.ts";
import {
  bisectPromptWindow,
  createSegmentParser,
  formatChunkAsPrompt,
  getExtractionRetryDelayMs,
  normalizeEmoji,
  partitionTranscriptionsForPrompt,
  transcriptionToUtterances,
} from "./shared.ts";

Deno.test("conversation extraction retries back off and remain bounded", () => {
  expect(getExtractionRetryDelayMs(1)).toBe(5 * 60 * 1000);
  expect(getExtractionRetryDelayMs(2)).toBe(10 * 60 * 1000);
  expect(getExtractionRetryDelayMs(99)).toBe(6 * 60 * 60 * 1000);
});

Deno.test("STT segments become timestamped prompt utterances", () => {
  const utterances = transcriptionToUtterances({
    start: "2026-07-10T10:00:00.000Z",
    end: "2026-07-10T10:00:30.000Z",
    segments: [
      { start: 0, end: 10, text: " First topic " },
      { start: 10, end: 25, text: "Second topic" },
    ],
  });

  expect(utterances).toEqual([
    {
      start: new Date("2026-07-10T10:00:00.000Z"),
      end: new Date("2026-07-10T10:00:10.000Z"),
      text: "First topic",
    },
    {
      start: new Date("2026-07-10T10:00:10.000Z"),
      end: new Date("2026-07-10T10:00:25.000Z"),
      text: "Second topic",
    },
  ]);

  expect(formatChunkAsPrompt(utterances).prompt).toContain(
    "[time: 2026-07-10T10:00:10.000Z]\nSecond topic",
  );
});

Deno.test("prompt partitioner enforces source-file boundaries", () => {
  const windows = partitionTranscriptionsForPrompt([
    {
      _id: "first",
      original: "source-a",
      start: "2026-07-10T10:00:00.000Z",
      end: "2026-07-10T10:00:10.000Z",
      text: "first",
    },
    {
      _id: "second",
      original: "source-b",
      start: "2026-07-10T10:00:11.000Z",
      end: "2026-07-10T10:00:20.000Z",
      text: "second",
    },
  ], 32_000);

  expect(windows).toHaveLength(2);
  expect(windows.map((window) => window.sourceKey)).toEqual([
    "source-a",
    "source-b",
  ]);
  expect(windows[1].boundaryReason).toBe("source_change");
});

Deno.test("replayed subtitle credits never enter extraction through segments or fallback text", () => {
  const credit = "Субтитры делал DimaTorzok";
  const legacy = {
    start: "2026-07-10T10:00:00.000Z",
    end: "2026-07-10T10:00:40.000Z",
    text: credit,
    segments: [{ start: 20, end: 40, text: credit }],
  };
  expect(
    partitionTranscriptionsForPrompt([legacy, { ...legacy, segments: [] }]),
  ).toEqual([]);
  const [mixed] = partitionTranscriptionsForPrompt([{
    ...legacy,
    segments: [{ start: 0, end: 2, text: "It worked." }, ...legacy.segments],
  }]);
  expect(mixed.prompt).toContain("It worked.");
  expect(mixed.prompt).not.toContain(credit);
  expect(mixed.end.toISOString()).toBe("2026-07-10T10:00:02.000Z");
});

Deno.test("prompt partitioner keeps every transcription once under the cap", () => {
  const transcriptions = ["a", "b", "c"].map((id, index) => ({
    _id: id,
    original: "source-a",
    start: new Date(Date.UTC(2026, 6, 10, 10, index)).toISOString(),
    end: new Date(Date.UTC(2026, 6, 10, 10, index, 30)).toISOString(),
    text: id.repeat(150),
  }));
  const windows = partitionTranscriptionsForPrompt(transcriptions, 400);

  expect(windows.length).toBeGreaterThan(1);
  expect(windows.every((window) => window.promptChars <= 400)).toBe(true);
  expect(
    windows.flatMap((window) =>
      window.transcriptions.map((transcription) => transcription._id)
    ),
  ).toEqual(["a", "b", "c"]);
});

Deno.test("one oversized transcription is divided at STT utterances", () => {
  const windows = partitionTranscriptionsForPrompt([{
    _id: "large",
    original: "source-a",
    start: "2026-07-10T10:00:00.000Z",
    end: "2026-07-10T10:01:00.000Z",
    segments: [
      { start: 0, end: 10, text: "a".repeat(140) },
      { start: 10, end: 20, text: "b".repeat(140) },
      { start: 20, end: 30, text: "c".repeat(140) },
    ],
  }], 300);

  expect(windows.length).toBeGreaterThan(1);
  expect(windows.every((window) => window.promptChars <= 300)).toBe(true);
  expect(windows.every((window) => window.transcriptions[0]._id === "large"))
    .toBe(true);
});

Deno.test("truncated prompt windows bisect their actual utterances", () => {
  const [window] = partitionTranscriptionsForPrompt([{
    _id: "large",
    original: "source-a",
    start: "2026-07-10T10:00:00.000Z",
    end: "2026-07-10T10:01:00.000Z",
    segments: [
      { start: 0, end: 10, text: "a".repeat(100) },
      { start: 10, end: 20, text: "b".repeat(200) },
      { start: 20, end: 30, text: "c".repeat(300) },
    ],
  }], 2_000);

  const children = bisectPromptWindow(window);
  expect(children).not.toBeNull();
  const [left, right] = children!;
  expect(left.promptChars).toBeLessThan(window.promptChars);
  expect(right.promptChars).toBeLessThan(window.promptChars);
  expect(right.boundaryReason).toBe("adaptive_truncation");
  expect([...left.utterances, ...right.utterances]).toEqual(window.utterances);
});

Deno.test("one long utterance can still be bisected after truncation", () => {
  const [window] = partitionTranscriptionsForPrompt([{
    _id: "single",
    original: "source-a",
    start: "2026-07-10T10:00:00.000Z",
    end: "2026-07-10T10:01:00.000Z",
    text: "first half of a long utterance second half of a long utterance",
  }], 2_000);

  const children = bisectPromptWindow(window);
  expect(children).not.toBeNull();
  const [left, right] = children!;
  expect(left.utterances[0].text.length).toBeGreaterThan(0);
  expect(right.utterances[0].text.length).toBeGreaterThan(0);
  expect(left.end).toEqual(right.start);
  expect(right.boundaryReason).toBe("adaptive_truncation");
});

Deno.test("segment parser resolves phrase boundaries through prompt time markers", () => {
  const parse = createSegmentParser(
    [
      "[time: 2026-07-28T08:00:00.000Z]",
      "First topic starts here",
      "[time: 2026-07-28T08:05:00.000Z]",
      "First topic ends here",
      "[time: 2026-07-28T08:10:00.000Z]",
    ],
    new Date("2026-07-28T07:55:00.000Z"),
    new Date("2026-07-28T08:15:00.000Z"),
  );

  expect(parse(JSON.stringify({
    segments: [{
      title: "First topic",
      start: "First topic starts here",
      end: "First topic ends here",
    }],
  }))).toEqual([{
    title: "First topic",
    start: new Date("2026-07-28T08:00:00.000Z"),
    end: new Date("2026-07-28T08:10:00.000Z"),
  }]);
});

Deno.test("duplicate and date-shaped phrases resolve to their spoken occurrences", () => {
  const [window] = partitionTranscriptionsForPrompt([{
    start: "2026-08-01T10:00:00.000Z",
    end: "2026-08-01T10:01:00.000Z",
    segments: [
      { start: 0, end: 1, text: "Hello again." },
      { start: 10, end: 11, text: "Hello again." },
      { start: 20, end: 22, text: "2026-08-01" },
    ],
  }]);
  const parse = createSegmentParser(
    window.prompt.split("\n"),
    window.start,
    window.end,
    window.utterancesByLine,
  );
  const segments = parse(JSON.stringify({
    segments: [
      { start: "Hello again.", end: "Hello again." },
      { start: "Hello again.", end: "Hello again." },
      { start: "2026-08-01", end: "2026-08-01" },
      { start: "2026-08-01T10:00:30Z", end: "2026-08-01T10:00:40Z" },
    ],
  }));
  expect(segments.map(({ start, end }) => [
    start.getTime() - window.start.getTime(),
    end.getTime() - window.start.getTime(),
  ])).toEqual([[0, 1_000], [10_000, 11_000], [20_000, 22_000], [
    30_000,
    40_000,
  ]]);
});

Deno.test("emoji normalization keeps one emoji grapheme", () => {
  expect(normalizeEmoji("🧠 Knowledge")).toBe("🧠");
  expect(normalizeEmoji("🇬🇧")).toBe("🇬🇧");
  expect(normalizeEmoji("none")).toBeUndefined();
  expect(normalizeEmoji(undefined)).toBeUndefined();
});

Deno.test("json_schema response format wraps the schema in the required envelope", () => {
  const format = buildJsonSchemaResponseFormat("conversation_metadata", {
    type: "object",
  });
  // Strict providers (vLLM, OpenRouter passthrough) reject a bare schema:
  // the {name, schema} envelope is mandatory.
  expect(format).toEqual({
    type: "json_schema",
    json_schema: {
      name: "conversation_metadata",
      schema: { type: "object" },
    },
  });
});

Deno.test("phrase boundaries that V8 parses as absurd dates are rejected", () => {
  // new Date("Так, 300.") parses to the year 300 — without the chunk-window
  // sanity check this became a conversation spanning year 0300 that no
  // transcript could ever match (summarization then failed forever).
  const parse = createSegmentParser(
    [
      "[time: 2026-08-06T02:14:15.000Z]",
      "Так, 300.",
      "[time: 2026-08-06T02:19:45.000Z]",
    ],
    new Date("2026-08-06T02:14:15.000Z"),
    new Date("2026-08-06T02:19:45.000Z"),
  );

  const [segment] = parse(JSON.stringify({
    segments: [{ title: "Price talk", start: "Так, 300.", end: "Так, 300." }],
  }));
  expect(segment.start.getFullYear()).toBe(2026);
  expect(segment.end.getFullYear()).toBe(2026);
  expect(segment.start.getTime()).toBeGreaterThanOrEqual(
    new Date("2026-08-06T02:14:15.000Z").getTime(),
  );
});
