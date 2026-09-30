export const AUDIO_OPERATIONS_SNAPSHOT_ID = "audio_operations:v1";
export const AUDIO_IMPORTS_INDEX = "audio_imports_recent_v1";
export let audioOperationsRevision = 0;

const CORE_COUNT_LABELS = new Set([
  "VAD coverage",
  "ready transcription sequences",
  "processing transcription sequences",
  "failed transcription sequences",
  "transcription backlog",
  "audio source totals",
]);

type MongoCall = (input: any) => Promise<any>;

/** Dashboard reads are two bounded indexed lookups, never corpus counts. */
export async function readAudioOperations(mongo: MongoCall) {
  const warnings: string[] = [];
  const [imports, snapshot] = await Promise.all([
    mongo({
      action: "find",
      collection: "source_files",
      query: { ingested: true, ingested_at: { $type: "date" } },
      options: {
        sort: { ingested_at: -1, _id: -1 },
        limit: 5,
        hint: AUDIO_IMPORTS_INDEX,
        maxTimeMS: 1_000,
        projection: {
          path: 1,
          start: 1,
          ingested_at: 1,
          "platform.importer": 1,
        },
      },
    }).catch(() => {
      warnings.push(
        "Recent imports unavailable; check the source index or retry later.",
      );
      return null;
    }),
    mongo({
      action: "findOne",
      collection: "jobs_dashboard_snapshots",
      query: { _id: AUDIO_OPERATIONS_SNAPSHOT_ID },
      options: { maxTimeMS: 1_000 },
    }).catch(() => {
      warnings.push("Saved audio counts are temporarily unavailable.");
      return null;
    }),
  ]);
  return {
    recentImports: imports?.map((source: any) => ({
      id: String(source._id),
      name: source.path?.split(/[\\/]/).pop() ?? String(source._id),
      recordedAt: source.start ?? null,
      importedAt: source.ingested_at,
      source: source.platform?.importer ?? "audio",
    })) ?? null,
    snapshot,
    warnings,
  };
}

/** Only an explicitly requested corpus calculation publishes these counts. */
export async function saveAudioOperations(
  mongo: MongoCall,
  stats: any,
  failedLabels?: string[],
) {
  // A partial calculation contains fallback zeros: preserve the last good data.
  // Unrelated history/diarization failures do not invalidate these core counts.
  const partial = failedLabels
    ? failedLabels.some((label) => CORE_COUNT_LABELS.has(label))
    : stats.warnings?.length > 0;
  await mongo({
    action: "updateOne",
    collection: "jobs_dashboard_snapshots",
    query: { _id: AUDIO_OPERATIONS_SNAPSHOT_ID },
    update: {
      $set: {
        lastAttemptAt: new Date(),
        state: partial ? "stale" : "ready",
        warning: partial
          ? "Some counts timed out; previous complete counts are retained."
          : null,
        ...(!partial
          ? {
            asOf: new Date(),
            data: {
              sourceFiles: stats.sourceFiles,
              vadPending: stats.chunksAwaitingVad,
              vadProcessed: stats.chunksVadProcessed,
              transcriptionPendingChunks: stats.transcriptionPendingChunks,
              sequencesReady: stats.sequencesReady,
              sequencesProcessing: stats.sequencesProcessing,
              sequencesError: stats.sequencesError,
            },
          }
          : {}),
      },
    },
    options: { upsert: true, maxTimeMS: 1_000 },
  });
  audioOperationsRevision++;
}
