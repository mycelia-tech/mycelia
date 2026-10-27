export type PurgeableRunStatus = "superseded" | "failed";

export type RunPurgeSnapshot = {
  runId: string;
  status: string;
  documents: number;
  embeddings: number;
  activeSegments: number;
  snapshotFingerprint: string;
  confirmation: string;
};

export function buildRunPurgeQueries(runId: string) {
  const deletable = {
    runId,
    lifecycleStatus: { $ne: "active" },
  };
  return {
    deletable,
    embeddings: { ...deletable, embedding: { $exists: true } },
    active: { runId, lifecycleStatus: "active" },
  };
}

export function buildRunPurgeSnapshot(input: {
  runId: string;
  status: string;
  documents: number;
  embeddings: number;
  activeSegments: number;
  purgedAt?: unknown;
}): RunPurgeSnapshot {
  if (input.status !== "superseded" && input.status !== "failed") {
    throw new Error(`Cannot purge a ${input.status} diarization run`);
  }
  if (input.purgedAt) {
    throw new Error("Diarization run was already purged");
  }
  const documents = Math.max(0, Math.trunc(input.documents));
  const embeddings = Math.max(0, Math.trunc(input.embeddings));
  const activeSegments = Math.max(0, Math.trunc(input.activeSegments));
  if (activeSegments > 0) {
    throw new Error(
      `Cannot purge a run that still has ${activeSegments} active segment(s)`,
    );
  }
  const snapshotFingerprint = [
    input.runId,
    input.status,
    documents,
    embeddings,
    activeSegments,
  ].join(":");
  return {
    runId: input.runId,
    status: input.status,
    documents,
    embeddings,
    activeSegments,
    snapshotFingerprint,
    confirmation: `PURGE ${input.runId} ${documents}`,
  };
}

export function assertRunPurgeSnapshotCurrent(
  expected: RunPurgeSnapshot,
  current: RunPurgeSnapshot,
  confirmation: string,
): void {
  if (
    expected.snapshotFingerprint !== current.snapshotFingerprint ||
    expected.confirmation !== current.confirmation ||
    confirmation !== current.confirmation
  ) {
    throw new Error(
      "Diarization run changed after purge preview; preview purge again",
    );
  }
}
