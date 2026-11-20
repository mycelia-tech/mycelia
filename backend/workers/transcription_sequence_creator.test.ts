import { expect } from "@std/expect";
import transcriptionSequenceCreator, {
  transcriptionSequencePendingQuery,
} from "./transcription_sequence_creator.ts";

Deno.test("sequence creator preflight skips an empty backlog", async () => {
  const requests: any[] = [];
  const pending = await transcriptionSequenceCreator.hasPendingWork?.({
    reason: "interval:300s",
    mongo: (request) => {
      requests.push(request);
      return Promise.resolve([]);
    },
  });

  expect(pending).toBe(0);
  expect(requests).toEqual([{
    action: "find",
    collection: "audio_chunks",
    query: transcriptionSequencePendingQuery,
    options: {
      projection: { _id: 1 },
      hint: "audio_chunks_sequence_pending_stats",
      limit: 1,
    },
  }]);
});

Deno.test("sequence creator preflight starts one job for pending work", async () => {
  const pending = await transcriptionSequenceCreator.hasPendingWork?.({
    reason: "new_speech_chunk",
    mongo: () => Promise.resolve([{ _id: "pending-chunk" }]),
  });

  expect(pending).toBe(1);
});
