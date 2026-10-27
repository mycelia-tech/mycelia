import { assertEquals } from "jsr:@std/assert@^1.0.15";
import { groupReviewSegments } from "./review-sessions.ts";

Deno.test("review grouping keeps only compatible nearby speaker segments together", () => {
  const base = {
    original_id: "recording-a",
    runId: "run-a",
    embeddingSpaceId: "space-a",
    speaker: "SPEAKER_01",
  };
  const groups = groupReviewSegments([
    { ...base, _id: "a", start: new Date(0), end: new Date(500) },
    { ...base, _id: "b", start: new Date(1_000), end: new Date(1_500) },
    {
      ...base,
      _id: "c",
      speaker: "SPEAKER_02",
      start: new Date(1_600),
      end: new Date(2_000),
    },
    {
      ...base,
      _id: "d",
      speaker: undefined,
      start: new Date(2_100),
      end: new Date(2_400),
    },
  ]);

  assertEquals(groups.map((group) => group.segmentIds), [["a", "b"], ["c"], [
    "d",
  ]]);
  assertEquals(groups[0].durationSeconds, 1.5);
});

Deno.test("review grouping respects configured size and wall-clock limits", () => {
  const segments = Array.from({ length: 4 }, (_, index) => ({
    _id: String(index),
    original_id: "recording-a",
    runId: "run-a",
    embeddingSpaceId: "space-a",
    speaker: "SPEAKER_01",
    start: new Date(index * 1_000),
    end: new Date(index * 1_000 + 500),
  }));

  assertEquals(
    groupReviewSegments(segments, { maxSegments: 2 }).map((group) =>
      group.segmentIds
    ),
    [["0", "1"], ["2", "3"]],
  );
  assertEquals(
    groupReviewSegments(segments, { maxDurationSeconds: 1.6 }).map((group) =>
      group.segmentIds
    ),
    [["0", "1"], ["2", "3"]],
  );
});
