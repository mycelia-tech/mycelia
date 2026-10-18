import { expect } from "@std/expect";
import { ObjectId } from "bson";
import {
  identityPublishedSourceSnapshotMatches,
  identitySourceBuildOwnsEpoch,
  identitySourceIndexSnapshot,
  identitySourcePartitionMatches,
  identitySourceSnapshotMatches,
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
