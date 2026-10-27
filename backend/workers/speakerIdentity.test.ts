import { expect } from "@std/expect";
import speakerIdentity, { schema } from "./speakerIdentity.ts";

const evidenceSnapshotHash = "sha256:evidence-v5";
const sourceSnapshot = {
  buildId: "source-build-4",
  revision: 4,
  membershipRevision: 0,
  builtAt: new Date("2026-08-24T13:00:00Z"),
  maxSegmentId: "6a8d00000000000000000020",
};

const profile = {
  _id: "698349a50dadb6125cb83312",
  name: "Sky",
  is_primary: true,
  revision: 5,
  embeddingSpaceId: "space-v5",
  embedding: [1, 0],
  enrollmentStatus: "ready",
  activeCalibrationIds: { full: "calibration-v5" },
  calibrationHeadsInitialized: true,
  calibrationEvidenceRevision: 2,
};

const calibration = {
  calibrationId: "calibration-v5",
  profileId: String(profile._id),
  profileRevision: 5,
  embeddingSpaceId: "space-v5",
  status: "validated",
  lifecycleStatus: "active",
  serverComputed: true,
  contractVersion: "server-computed-v1",
  computedBy: "speaker-segments",
  targetPrecision: 0.98,
  classificationPolicy: "full",
  validationMetrics: {
    positivePrecision: 1,
    negativePrecision: 1,
    identified: 20,
    rejected: 20,
    positives: 20,
    negatives: 20,
  },
  calibrationRecordingIds: ["fit"],
  validationRecordingIds: ["check"],
  positiveThreshold: 0.7,
  negativeThreshold: -1,
  negativeDecisionMode: "uncertain_only",
  evidenceSnapshotHash,
  evidenceRevision: 2,
};

const belkaProfile = {
  ...profile,
  _id: "698349a50dadb6125cb83313",
  name: "Belka",
  activeCalibrationIds: { full: "calibration-belka-v3" },
  revision: 3,
};

const belkaCalibration = {
  ...calibration,
  calibrationId: "calibration-belka-v3",
  profileId: String(belkaProfile._id),
  profileRevision: 3,
  evidenceSnapshotHash: "sha256:evidence-belka-v3",
};

const profileSnapshots = [
  {
    profileId: String(profile._id),
    profileRevision: 5,
    calibrationId: calibration.calibrationId,
    embeddingSpaceId: "space-v5",
    evidenceSnapshotHash,
  },
  {
    profileId: String(belkaProfile._id),
    profileRevision: 3,
    calibrationId: belkaCalibration.calibrationId,
    embeddingSpaceId: "space-v5",
    evidenceSnapshotHash: belkaCalibration.evidenceSnapshotHash,
  },
];

function createAutomaticMongo(
  { profileOverride = profile, includeBaseline = true }: {
    profileOverride?: Record<string, any>;
    includeBaseline?: boolean;
  } = {},
) {
  const requests: Record<string, any>[] = [];
  let insertedCampaign: Record<string, any> | null = null;
  const mongo = async (request: Record<string, any>) => {
    requests.push(request);
    if (request.collection === "identity_model_set_heads") {
      return [{
        embeddingSpaceId: "space-v5",
        activeModelSetId: "model-set-active",
      }];
    }
    if (request.collection === "identity_model_sets") {
      return {
        modelSetId: "model-set-active",
        status: "active",
        embeddingSpaceId: "space-v5",
        profiles: profileSnapshots,
        coverage: { totalSegments: 23, projectedSegments: 23 },
      };
    }
    if (request.collection === "speaker_profiles") {
      return String(request.query?._id) === String(belkaProfile._id)
        ? belkaProfile
        : profileOverride;
    }
    if (request.collection === "speaker_calibrations") {
      return request.query?.calibrationId === belkaCalibration.calibrationId
        ? belkaCalibration
        : calibration;
    }
    if (
      request.collection === "speaker_identity_campaigns" &&
      request.query?.status === "completed"
    ) {
      return includeBaseline
        ? {
          _id: "baseline",
          campaignId: "baseline-model-set",
          finishedAt: new Date("2026-08-24T12:00:00Z"),
          sourceSnapshot: { ...sourceSnapshot, revision: 3 },
          partitions: [
            {
              runId: "unchanged",
              embeddingSpaceId: "space-v5",
              sourceSegments: 5,
              maxSegmentId: "6a8c00000000000000000005",
            },
            {
              runId: "legacy-v0",
              embeddingSpaceId: "space-v5",
              sourceSegments: 18,
              maxSegmentId: "6a8d00000000000000000018",
            },
          ],
        }
        : null;
    }
    if (
      request.collection === "speaker_identity_campaigns" &&
      request.action === "insertOne"
    ) {
      insertedCampaign = request.doc;
      return { insertedId: "automatic-campaign" };
    }
    if (request.collection === "speaker_identity_campaigns") return null;
    if (request.collection === "speaker_identity_source_index") {
      return {
        _id: "active",
        status: "ready",
        publishedBuildId: sourceSnapshot.buildId,
        publishedRevision: sourceSnapshot.revision,
        membershipRevision: sourceSnapshot.membershipRevision,
        publishedAt: sourceSnapshot.builtAt,
        publishedMaxSegmentId: sourceSnapshot.maxSegmentId,
      };
    }
    if (request.collection === "speaker_identity_source_partitions") {
      return [
        {
          buildId: sourceSnapshot.buildId,
          sourceRevision: sourceSnapshot.revision,
          runId: "unchanged",
          embeddingSpaceId: "space-v5",
          sourceSegments: 5,
          start: new Date("2026-08-23T00:00:00Z"),
          end: new Date("2026-08-23T00:00:10Z"),
          maxSegmentId: "6a8c00000000000000000005",
          status: "ready",
        },
        {
          buildId: sourceSnapshot.buildId,
          sourceRevision: sourceSnapshot.revision,
          runId: "legacy-v0",
          embeddingSpaceId: "space-v5",
          sourceSegments: 20,
          start: new Date("2026-08-24T00:00:00Z"),
          end: new Date("2026-08-24T00:00:10Z"),
          maxSegmentId: sourceSnapshot.maxSegmentId,
          status: "ready",
        },
      ];
    }
    throw new Error(`Unexpected request: ${JSON.stringify(request)}`);
  };
  return {
    mongo,
    requests,
    insertedCampaign: () => insertedCampaign,
  };
}

Deno.test("automatic identity waits for a completed baseline then snapshots new segments", async () => {
  const fixture = createAutomaticMongo();
  expect(
    await speakerIdentity.hasPendingWork?.({
      mongo: fixture.mongo,
      reason: "test",
    }),
  ).toBe(1);

  const data = await speakerIdentity.getTriggerJobData?.(
    undefined,
    "test",
    { mongo: fixture.mongo },
  );
  expect(schema.safeParse(data).success).toBe(true);
  const { profileSnapshots: _omitted, ...withoutProfileSnapshots } = data ?? {};
  expect(schema.safeParse(withoutProfileSnapshots).success).toBe(false);
  expect(data?.type).toBe("speakerIdentity");
  expect(data?.campaignMode).toBe("classify_automatic");
  expect(data?.modelSetId).toBe("model-set-active");
  expect(data?.profileSnapshots).toEqual(profileSnapshots);
  expect(data?.campaignTotalSegments).toBe(25);
  expect(data?.runId).toBe("legacy-v0");
  expect(data?.partitionIndex).toBe(1);
  expect((data?.partitions as any[])?.length).toBe(2);
  expect((data?.partitions as any[])?.[0]?.eligibleSegments).toBe(0);
  expect((data?.partitions as any[])?.[1]).toMatchObject({
    sourceSegments: 20,
    eligibleSegments: 2,
    afterSegmentId: "6a8d00000000000000000018",
  });
  expect(data?.sourceSnapshot).toEqual(sourceSnapshot);
  expect(fixture.insertedCampaign()).toMatchObject({
    modelSetId: "model-set-active",
    profileIds: profileSnapshots.map((snapshot) => snapshot.profileId),
    totalSegments: 25,
    processedSegments: 23,
    pendingSegments: 2,
    partitionIndex: 1,
  });

  const baselineRequest = fixture.requests.find((request) =>
    request.collection === "speaker_identity_campaigns" &&
    request.query?.status === "completed"
  );
  expect(baselineRequest?.query?.modelSetId).toBe("model-set-active");

  const profileRequests = fixture.requests.filter((request) =>
    request.collection === "speaker_profiles"
  );
  expect(profileRequests).toHaveLength(4);
  expect(profileRequests[0]?.options?.projection?.activeCalibrationIds).toBe(1);
  expect(
    fixture.requests.some((request) =>
      request.collection === "diarizations" && request.action === "aggregate"
    ),
  ).toBe(false);
});

Deno.test("automatic identity waits when a frozen profile changed", async () => {
  const fixture = createAutomaticMongo({
    profileOverride: { ...profile, revision: 6 },
  });
  expect(
    await speakerIdentity.hasPendingWork?.({
      mongo: fixture.mongo,
      reason: "test",
    }),
  ).toBe(false);
});

Deno.test("automatic identity does not run before the active model set has a completed baseline", async () => {
  const fixture = createAutomaticMongo({ includeBaseline: false });
  expect(
    await speakerIdentity.hasPendingWork?.({
      mongo: fixture.mongo,
      reason: "test",
    }),
  ).toBe(false);
});

Deno.test("automatic identity listens for a published source snapshot", () => {
  expect(speakerIdentity.triggers?.sources).toEqual([{
    channel: "mycelia:mongo:speaker_identity_source_index",
    name: "speaker_identity_source_ready",
    filter: {
      event: "mongo.change",
      "data.document.status": "ready",
    },
  }]);
});

Deno.test("model-set identity payload does not require legacy scalar fields", () => {
  const modelSetPayload = {
    type: "speakerIdentity",
    runId: "legacy-v0",
    modelSetId: "model-set-2",
    profileSnapshots: [{
      profileId: String(profile._id),
      profileRevision: 5,
      calibrationId: calibration.calibrationId,
      embeddingSpaceId: "space-v5",
      evidenceSnapshotHash,
    }],
    sourceSnapshot,
    partitions: [{
      runId: "legacy-v0",
      embeddingSpaceId: "space-v5",
      start: new Date("2026-08-24T00:00:00Z"),
      end: new Date("2026-08-24T00:00:10Z"),
      eligibleSegments: 20,
      sourceSegments: 20,
      indexedSourceSegments: 20,
      sourceBuildId: sourceSnapshot.buildId,
      sourceRevision: sourceSnapshot.revision,
      maxSegmentId: sourceSnapshot.maxSegmentId,
    }],
  };
  expect(schema.safeParse(modelSetPayload).success).toBe(true);
  expect(
    schema.safeParse({
      ...modelSetPayload,
      sourceSnapshot: undefined,
    }).success,
  ).toBe(false);
});
