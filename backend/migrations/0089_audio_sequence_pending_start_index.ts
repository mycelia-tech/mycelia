import type { Db } from "mongodb";
import { ensureIndexExists } from "@/utils/migrations.ts";

const INDEX_NAME = "audio_chunks_sequence_pending_start_v1";

export async function up(db: Db): Promise<void> {
  await ensureIndexExists(
    db,
    "audio_chunks",
    { transcription_sequence_id: 1, start: -1 },
    {
      name: INDEX_NAME,
      partialFilterExpression: {
        transcribed_at: null,
        processing_by: null,
        "vad.has_speech": true,
      },
    },
  );
}

export async function down(db: Db): Promise<void> {
  const chunks = db.collection("audio_chunks");
  if (await chunks.indexExists(INDEX_NAME)) {
    await chunks.dropIndex(INDEX_NAME);
  }
}
