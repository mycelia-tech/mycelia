import { expect } from "@std/expect";
import { combinedWavDurationSeconds } from "@/lib/audio-combiner.ts";
import { filterSegments } from "@/lib/transcription-filters.ts";
import transcription, {
  aggregateBatchTranscriptionResult,
  buildTranscribedChunkQuery,
  buildTranscriptionSequenceClaimQuery,
} from "./transcription.ts";

Deno.test("VAD-confirmed short replies survive postprocessing", () => {
  for (const text of [" Спасибо.", "Okay.", "uh", "- Yeah.", "Ну..."]) {
    const segment = { text, start: 3, end: 3.6 };
    expect(filterSegments([segment], 5, true)).toEqual([segment]);
    expect(filterSegments([segment], 5)).toEqual([]);
  }
  for (const text of ["...", "*mimics*", "Субтитры делал DimaTorzok"]) {
    expect(filterSegments([{ text, start: 0, end: 1 }], 5, true)).toEqual([]);
  }
});

Deno.test("standalone subtitle credits are empty and quoted credits survive", () => {
  for (const text of [" Субтитры делал DimaTorzok", "Субтитры сделал DIMATORZOK… "]) {
    expect(filterSegments([{ text, start: 0, end: 29.98 }], 20)).toEqual([]);
  }
  const quote = { text: "Он сказал: субтитры делал DimaTorzok.", start: 5, end: 8 };
  expect(filterSegments([quote], 20)).toEqual([quote]);
});

Deno.test("ASR segments and words stay within the decoded PCM, including WAV metadata", () => {
  // A mono PCM16 WAV with an odd-sized metadata chunk before 20 s of samples.
  const pcmBytes = 20 * 16000 * 2;
  const bytes = new Uint8Array(54 + pcmBytes);
  const header = new DataView(bytes.buffer);
  const put = (offset: number, tag: string) =>
    bytes.set(new TextEncoder().encode(tag), offset);
  put(0, "RIFF");
  header.setUint32(4, bytes.length - 8, true);
  put(8, "WAVEfmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, 16000, true);
  header.setUint32(28, 32000, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  put(36, "JUNK");
  header.setUint32(40, 1, true);
  put(46, "data");
  header.setUint32(50, pcmBytes, true);

  const duration = combinedWavDurationSeconds(bytes);
  expect(duration).toBe(20);
  const word = { word: " Да", start: 19, end: 29.98, probability: 0.9 };
  const segment = { text: " Да", start: 19, end: 29.98, words: [word] };
  expect(filterSegments([
    segment,
    { text: "Субтитры делал DimaTorzok", start: 0, end: 29.98 },
    { text: "After the recording", start: 20, end: 30 },
  ], duration)).toEqual([{ ...segment, end: 20, words: [{ ...word, end: 20 }] }]);
});

Deno.test("batch result remains transcribed when its final sequence is empty", () => {
  const transcribed = {
    status: "success",
    result: "transcribed",
    transcriptionId: "saved-transcription",
    wordCount: 42,
    textLength: 240,
    segmentCount: 7,
    audioSize: 1024,
    textPreview: "Saved speech",
  };
  const empty = {
    status: "success",
    result: "empty",
    transcriptionId: null,
    wordCount: 0,
    textLength: 0,
    segmentCount: 0,
    audioSize: 0,
  };

  expect(aggregateBatchTranscriptionResult(empty, [transcribed, empty]))
    .toMatchObject({
      result: "transcribed",
      transcriptionId: "saved-transcription",
      wordCount: 42,
      textLength: 240,
      segmentCount: 7,
      audioSize: 1024,
      textPreview: "Saved speech",
    });
});

Deno.test("batch result stays empty when no sequence saved a transcription", () => {
  const empty = {
    status: "success",
    result: "empty",
    processed: 1,
    transcriptionId: null,
    wordCount: 0,
    segmentCount: 0,
  };

  expect(aggregateBatchTranscriptionResult(empty, [empty, empty])).toEqual(
    empty,
  );
});

Deno.test("sequence claiming recovers stale processing work", () => {
  const now = new Date("2026-08-13T00:00:00.000Z");
  expect(buildTranscriptionSequenceClaimQuery(now)).toEqual({
    $or: [
      { state: "ready" },
      {
        state: "error",
        updatedAt: { $lt: new Date("2026-08-12T23:30:00.000Z") },
      },
      {
        state: "processing",
        updatedAt: { $lt: new Date("2026-08-12T23:30:00.000Z") },
      },
    ],
  });
});

Deno.test("automatic transcription preflight uses the claim query", async () => {
  const calls: any[] = [];
  const pending = await transcription.hasPendingWork?.({
    mongo: async (input) => {
      calls.push(input);
      return [{ _id: "sequence" }];
    },
    reason: "interval",
  });

  expect(pending).toBe(1);
  expect(calls).toHaveLength(1);
  expect(calls[0].action).toBe("find");
  expect(calls[0].query.$or.map((entry: any) => entry.state)).toEqual([
    "ready",
    "error",
    "processing",
  ]);
  expect(calls[0].options.hint).toBe(
    "transcription_sequences_claimable_work_v1",
  );
});

Deno.test("terminal transcription marks only chunks owned by its sequence", () => {
  const id = { toString: () => "sequence-1" };
  expect(buildTranscribedChunkQuery({ _id: id })).toEqual({
    transcription_sequence_id: id,
  });
});
