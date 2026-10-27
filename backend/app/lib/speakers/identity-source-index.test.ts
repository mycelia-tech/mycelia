import { expect } from "@std/expect";
import { ObjectId } from "bson";
import {
  identityPublishedSourceSnapshotMatches,
  identitySourceBuildOwnsEpoch,
  identitySourceIndexSnapshot,
  identitySourceIndexView,
  identitySourcePartitionMatches,
  identitySourceSnapshotMatches,
  planIdentitySourceIndexReservationRecovery,
  summarizeIdentitySourceBatch,
} from "./identity-source-index.ts";

Deno.test("source batches materialize stable run and embedding-space partitions", () => {
  const rows = [
    {
      _id: new ObjectId("6a8d00000000000000000001"),
      runId: "legacy-v0",
      embeddingSpaceId: "space-v1",
      start: new Date("2026-08-01T00:00:03Z"),
      end: new Date("2026-08-01T00:00:05Z"),
    },
    {
      _id: new ObjectId("6a8d00000000000000000002"),
      runId: "legacy-v0",
      embeddingSpaceId: "space-v1",
      start: new Date("2026-08-01T00:00:01Z"),
      end: new Date("2026-08-01T00:00:08Z"),
    },
    {
      _id: new ObjectId("6a8d00000000000000000003"),
      runId: "generation-9",
      embeddingSpaceId: "space-v2",
      start: new Date("2026-08-02T00:00:00Z"),
      end: new Date("2026-08-02T00:00:04Z"),
    },
  ];

  expect(summarizeIdentitySourceBatch(rows)).toEqual([
    {
      runId: "legacy-v0",
      embeddingSpaceId: "space-v1",
      sourceSegments: 2,
      start: new Date("2026-08-01T00:00:01Z"),
      end: new Date("2026-08-01T00:00:08Z"),
      maxSegmentId: rows[1]._id,
    },
    {
      runId: "generation-9",
      embeddingSpaceId: "space-v2",
      sourceSegments: 1,
      start: new Date("2026-08-02T00:00:00Z"),
      end: new Date("2026-08-02T00:00:04Z"),
      maxSegmentId: rows[2]._id,
    },
  ]);
});

Deno.test("source snapshots allow appends but reject equal-count membership replacement", () => {
  const ready = {
    status: "ready",
    publishedBuildId: "build-1",
    publishedRevision: 3,
    membershipRevision: 7,
    publishedAt: new Date("2026-08-01T00:00:00Z"),
    publishedMaxSegmentId: new ObjectId("6a8d00000000000000000010"),
  };
  const snapshot = identitySourceIndexSnapshot(ready)!;
  expect(identityPublishedSourceSnapshotMatches(snapshot, ready)).toBe(true);

  // A later append can publish a new build without invalidating the frozen
  // source prefix held by an already-started campaign.
  expect(identitySourceSnapshotMatches(snapshot, {
    ...ready,
    status: "counting",
    publishedBuildId: "build-2",
    publishedRevision: 4,
    dirtyEpoch: 12,
  })).toBe(true);

  // Activation can replace one segment with another while keeping the same
  // count. membershipRevision, not the count, detects that unsafe change.
  expect(identitySourceSnapshotMatches(snapshot, {
    ...ready,
    publishedBuildId: "build-2",
    publishedRevision: 4,
    membershipRevision: 8,
  })).toBe(false);
});

Deno.test("an in-flight build loses publication ownership when dirty epoch changes", () => {
  const state = {
    status: "counting",
    dirtyEpoch: 5,
    membershipRevision: 2,
    activeBuild: { buildId: "build-1", dirtyEpoch: 5 },
  };
  expect(identitySourceBuildOwnsEpoch(state, "build-1", 5)).toBe(true);
  expect(
    identitySourceBuildOwnsEpoch({ ...state, dirtyEpoch: 6 }, "build-1", 5),
  )
    .toBe(false);
});

Deno.test("scoped preflight validates the immutable indexed partition", () => {
  expect(identitySourcePartitionMatches({
    runId: "legacy-v0",
    embeddingSpaceId: "space-v1",
    sourceSegments: 10,
    indexedSourceSegments: 100,
    sourceBuildId: "build-1",
    sourceRevision: 3,
    maxSegmentId: "6a8d00000000000000000010",
  }, {
    runId: "legacy-v0",
    embeddingSpaceId: "space-v1",
    sourceSegments: 100,
    buildId: "build-1",
    sourceRevision: 3,
    maxSegmentId: new ObjectId("6a8d00000000000000000010"),
  })).toBe(true);
});

Deno.test("completed source-index batch with more work no longer fences restart recovery", () => {
  const jobId = "6ad4f25cbe01f4d421bf1fbb";
  const plan = planIdentitySourceIndexReservationRecovery(
    {
      status: "counting",
      currentJobId: jobId,
    },
    new Map([[jobId, {
      _id: new ObjectId(jobId),
      state: "completed",
      result: { hasMore: true, processed: 10_000 },
    }]]),
  );

  expect(plan).toEqual({
    clearCurrentJobId: true,
    clearQueuedJobId: false,
    adoptJobId: null,
    adoptAs: null,
    hasLiveReservation: false,
  });
});

Deno.test("active source-index job keeps its reservation and prevents duplicates", () => {
  const jobId = "6ad4f25cbe01f4d421bf1fbc";
  const plan = planIdentitySourceIndexReservationRecovery(
    {
      status: "counting",
      currentJobId: jobId,
    },
    new Map([[jobId, {
      _id: new ObjectId(jobId),
      state: "active",
    }]]),
  );

  expect(plan).toEqual({
    clearCurrentJobId: false,
    clearQueuedJobId: false,
    adoptJobId: null,
    adoptAs: null,
    hasLiveReservation: true,
  });
});

Deno.test("unlinked waiting continuation is adopted instead of duplicated", () => {
  const completedJobId = "6ad4f25cbe01f4d421bf1fbd";
  const continuationJobId = "6ad4f25cbe01f4d421bf1fbe";
  const plan = planIdentitySourceIndexReservationRecovery(
    {
      status: "counting",
      currentJobId: completedJobId,
    },
    new Map([
      [completedJobId, {
        _id: new ObjectId(completedJobId),
        type: "speakerIdentitySourceIndex",
        state: "completed",
        result: { hasMore: true, processed: 10_000 },
      }],
      [continuationJobId, {
        _id: new ObjectId(continuationJobId),
        type: "speakerIdentitySourceIndex",
        state: "waiting",
      }],
    ]),
  );

  expect(plan).toEqual({
    clearCurrentJobId: true,
    clearQueuedJobId: false,
    adoptJobId: continuationJobId,
    adoptAs: "queued",
    hasLiveReservation: true,
  });
});

Deno.test("source index view exposes the bounded worker recovery wait", () => {
  const view = identitySourceIndexView({
    status: "counting",
    currentJobId: "6ad4f25cbe01f4d421bf1fbb",
    activeBuild: {
      scannedSegments: 560_000,
      batchCount: 56,
      lastBatchAt: new Date("2026-10-18T16:35:42Z"),
    },
  }, new Date("2026-10-18T16:38:00Z"));

  expect(view.recoveryWaiting).toBe(true);
  expect(view.lastProgressAt).toEqual(new Date("2026-10-18T16:35:42Z"));
});
