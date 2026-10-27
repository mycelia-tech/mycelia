import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1.0.15";
import { ObjectId } from "bson";
import {
  annotationResolvesReviewForProfile,
  buildReviewCandidateQuery,
  buildReviewHistoryRevisionScope,
  buildReviewScanMetadata,
  commitReviewDecisionArtifacts,
  eligibleReviewDecisionProfileIds,
  frozenIdentitySourceCeiling,
  resolveReviewCandidateContext,
  reviewCandidateMatchesIdentity,
  sameIdentityProfileSnapshots,
  speakerSegmentsRequestSchema,
  stratifyReviewCandidates,
} from "./resource.server.ts";
import {
  applyReviewDecisionRevision,
  attachReviewDecisionSummaries,
  latestReviewAnnotationsBySegment,
  prepareReviewCandidates,
  restoreReviewDecision,
} from "./review-sessions.ts";

const sessionId = "66b000000000000000000050";
const segmentId = "66b000000000000000000001";
const skyProfileId = "66b000000000000000000010";
const otherProfileId = "66b000000000000000000020";
const recordingId = "66b000000000000000000030";

Deno.test("review artifact commit invalidates eligible evidence and model sets only", async () => {
  const segment = {
    _id: segmentId,
    original_id: recordingId,
    start: new Date("2026-08-01T00:00:00Z"),
    end: new Date("2026-08-01T00:00:05Z"),
  };
  for (const calibrationUse of ["eligible", "timeline_only"] as const) {
    const requests: any[] = [];
    await commitReviewDecisionArtifacts(
      async (request: any) => {
        requests.push(request);
        return { matchedCount: 1, modifiedCount: 1 };
      },
      {
        _id: "66b000000000000000000099",
        sessionId,
        segmentIds: [segmentId],
        targetProfileIds: [skyProfileId],
        outcome: "assigned",
        profileId: otherProfileId,
        excludedProfileIds: [skyProfileId],
        calibrationUse,
        status: "building",
      },
      [segment],
    );

    const invalidatedCollections = requests
      .filter((request) => request.action === "updateMany")
      .map((request) => request.collection)
      .sort();
    assertEquals(
      invalidatedCollections,
      calibrationUse === "eligible"
        ? [
          "identity_model_sets",
          "identity_model_sets",
          "speaker_calibrations",
          "speaker_identity_evaluations",
          "speaker_profiles",
        ]
        : [],
    );
    if (calibrationUse === "eligible") {
      const modelSetUpdates = requests.filter((request) =>
        request.action === "updateMany" &&
        request.collection === "identity_model_sets"
      );
      assertEquals(modelSetUpdates[0].query.status, {
        $in: ["building", "ready"],
      });
      assertEquals(modelSetUpdates[1].query.status, "active");
      assertEquals(modelSetUpdates[1].update.$set.status, undefined);
      assertEquals(modelSetUpdates[1].update.$addToSet.staleProfileIds.$each, [
        skyProfileId,
        otherProfileId,
      ]);
    }
  }
  assertEquals(eligibleReviewDecisionProfileIds({ outcome: "skipped" }), []);
  assertEquals(
    eligibleReviewDecisionProfileIds({
      outcome: "assigned",
      calibrationUse: "timeline_only",
      targetProfileIds: [skyProfileId],
    }),
    [],
  );
});

Deno.test("identity preflight freezes every profile snapshot and source ceiling", () => {
  const snapshots = [{
    profileId: skyProfileId,
    profileRevision: 7,
    calibrationId: "sky-r7",
    embeddingSpaceId: "space-v2",
    evidenceSnapshotHash: "evidence-7",
  }, {
    profileId: otherProfileId,
    profileRevision: 3,
    calibrationId: "belka-r3",
    embeddingSpaceId: "space-v2",
    evidenceSnapshotHash: "evidence-3",
  }];
  assert(sameIdentityProfileSnapshots(snapshots, [...snapshots].reverse()));
  assertEquals(
    sameIdentityProfileSnapshots(snapshots, [
      snapshots[0],
      { ...snapshots[1], profileRevision: 4 },
    ]),
    false,
  );
  assertEquals(frozenIdentitySourceCeiling(segmentId), {
    _id: { $lte: new ObjectId(segmentId) },
  });
  assertEquals(frozenIdentitySourceCeiling("legacy-missing"), {});
});

Deno.test("review decision assigns another profile while excluding the calibration target", () => {
  const result = speakerSegmentsRequestSchema.safeParse({
    action: "commit-review-decision",
    sessionId,
    revision: 1,
    clientRequestId: "assign-other-profile",
    segmentIds: [segmentId],
    profileId: otherProfileId,
    excludedProfileIds: [skyProfileId],
  });

  assert(result.success);
  assertEquals(result.data.action, "commit-review-decision");
  if (result.data.action === "commit-review-decision") {
    assertEquals(result.data.profileId, otherProfileId);
    assertEquals(result.data.excludedProfileIds, [skyProfileId]);
  }
});

Deno.test("review decision rejects excluding the assigned profile", () => {
  const result = speakerSegmentsRequestSchema.safeParse({
    action: "commit-review-decision",
    sessionId,
    revision: 1,
    clientRequestId: "contradictory-profile",
    segmentIds: [segmentId],
    profileId: otherProfileId,
    excludedProfileIds: [otherProfileId],
  });

  assertEquals(result.success, false);
});

Deno.test("review revision contract requires the decision being replaced", () => {
  const result = speakerSegmentsRequestSchema.safeParse({
    action: "revise-review-decision",
    sessionId,
    revision: 3,
    clientRequestId: "correct-one-segment",
    segmentIds: [segmentId],
    replacesDecisionId: "66b000000000000000000099",
    profileId: skyProfileId,
    excludedProfileIds: [],
  });

  assert(result.success);
  assertEquals(result.data.action, "revise-review-decision");
});

Deno.test(
  "review history revision only replaces this profile decision and its annotation",
  () => {
    const decisionId = new ObjectId("66b000000000000000000099");
    const author = "reviewer@example.com";
    const scope = buildReviewHistoryRevisionScope({
      segmentId: new ObjectId(segmentId),
      profileId: new ObjectId(skyProfileId),
      decisionId,
      author,
    });

    assertEquals(scope.currentDecision, {
      segmentIds: new ObjectId(segmentId),
      targetProfileIds: new ObjectId(skyProfileId),
      author,
      status: "committed",
    });
    assertEquals(scope.replacedAnnotation, {
      segmentId: new ObjectId(segmentId),
      decisionId,
      source: "manual",
      author,
    });
  },
);

Deno.test("undo contract carries the session revision", () => {
  const result = speakerSegmentsRequestSchema.safeParse({
    action: "undo-review-decision",
    sessionId,
    revision: 4,
    decisionId: "66b000000000000000000099",
  });

  assert(result.success);
});

Deno.test("review revision changes only selected rows and preserves reviewed state", () => {
  const oldDecisionId = "66b000000000000000000099";
  const newDecisionId = "66b000000000000000000100";
  const window = [
    {
      segmentId,
      groupId: "group-1",
      status: "reviewed",
      decisionId: oldDecisionId,
    },
    {
      segmentId: "66b000000000000000000002",
      groupId: "group-1",
      status: "reviewed",
      decisionId: oldDecisionId,
    },
  ];

  const revised = applyReviewDecisionRevision(window, {
    segmentIds: [segmentId],
    replacesDecisionId: oldDecisionId,
    decisionId: newDecisionId,
  });

  assertEquals(revised, [
    {
      segmentId,
      groupId: "group-1",
      status: "reviewed",
      decisionId: newDecisionId,
    },
    window[1],
  ]);
  assertThrows(
    () =>
      applyReviewDecisionRevision(window, {
        segmentIds: [segmentId],
        replacesDecisionId: "66b000000000000000000098",
        decisionId: newDecisionId,
      }),
    Error,
    "Review decision changed elsewhere",
  );
});

Deno.test("undo refuses a superseded decision and counts only restored rows", () => {
  const oldDecisionId = "66b000000000000000000099";
  const newDecisionId = "66b000000000000000000100";
  const neighborId = "66b000000000000000000002";
  const currentWindow = [
    { segmentId, status: "reviewed", decisionId: newDecisionId },
    { segmentId: neighborId, status: "reviewed", decisionId: oldDecisionId },
  ];

  const restored = restoreReviewDecision(currentWindow, {
    segmentIds: [segmentId, neighborId],
    decisionId: oldDecisionId,
  });
  assertEquals(restored.restoredCount, 1);
  assertEquals(restored.firstRestored, neighborId);
  assertEquals(restored.window, [
    currentWindow[0],
    { segmentId: neighborId, status: "pending", decisionId: null },
  ]);

  assertThrows(
    () =>
      restoreReviewDecision(currentWindow, {
        segmentIds: [segmentId],
        decisionId: oldDecisionId,
      }),
    Error,
    "Review decision is no longer current",
  );
});

Deno.test("review hydration exposes assigned and deleted profile names", () => {
  const assignedDecisionId = "66b000000000000000000099";
  const deletedDecisionId = "66b000000000000000000100";
  const deletedProfileId = "66b000000000000000000030";
  const updatedAt = new Date("2026-08-12T08:00:00.000Z");
  const window = [
    { segmentId, status: "reviewed", decisionId: assignedDecisionId },
    {
      segmentId: "66b000000000000000000002",
      status: "reviewed",
      decisionId: deletedDecisionId,
    },
  ];

  const hydrated = attachReviewDecisionSummaries(window, [
    {
      _id: assignedDecisionId,
      profileId: otherProfileId,
      excludedProfileIds: [skyProfileId],
      source: "review_single",
      updatedAt,
    },
    {
      _id: deletedDecisionId,
      profileId: deletedProfileId,
      excludedProfileIds: [skyProfileId],
      source: "review_single",
      updatedAt,
    },
  ], [
    { _id: skyProfileId, name: "Sky" },
    { _id: otherProfileId, name: "Belka" },
  ]);

  assertEquals(hydrated[0].decisionSummary, {
    decisionId: assignedDecisionId,
    outcome: "assigned",
    profileId: otherProfileId,
    profileName: "Belka",
    excludedProfileIds: [skyProfileId],
    excludedProfileNames: ["Sky"],
    calibrationUse: "eligible",
    skipReason: null,
    source: "manual",
    updatedAt,
  });
  assertEquals(hydrated[1].decisionSummary?.profileName, "Deleted profile");
});

Deno.test("label counts use only the latest annotation for each segment", () => {
  const latest = latestReviewAnnotationsBySegment([
    {
      segmentId,
      profileId: skyProfileId,
      updatedAt: new Date("2026-08-12T08:00:00Z"),
    },
    {
      segmentId,
      profileId: otherProfileId,
      excludedProfileIds: [skyProfileId],
      updatedAt: new Date("2026-08-12T09:00:00Z"),
    },
  ]);

  assertEquals(latest.length, 1);
  assertEquals(latest[0].profileId, otherProfileId);
});

Deno.test("review windows take candidates across recordings before repeating one", () => {
  const candidates = [
    { _id: "a1", original_id: "recording-a" },
    { _id: "a2", original_id: "recording-a" },
    { _id: "a3", original_id: "recording-a" },
    { _id: "b1", original_id: "recording-b" },
    { _id: "c1", original_id: "recording-c" },
  ];
  const { selected, remaining } = stratifyReviewCandidates(candidates, 3);

  assertEquals(selected.map((item) => item._id), ["a1", "b1", "c1"]);
  assertEquals(remaining.map((item) => item._id), ["a2", "a3"]);
});

Deno.test("review candidate query enforces generation, embedding space, recording, and range", () => {
  const start = new Date("2026-08-01T00:00:00Z");
  const end = new Date("2026-08-02T00:00:00Z");
  const query = buildReviewCandidateQuery(
    start,
    end,
    "reviewable",
    skyProfileId,
    null,
    {
      runIds: ["generation-7"],
      embeddingSpaceIds: ["space-v2"],
      recordingIds: [recordingId],
    },
  ) as any;

  assertEquals(query.lifecycleStatus, "active");
  assertEquals(query.start, { $lt: end });
  assertEquals(query.end, { $gt: start });
  assert(
    query.$and.some((condition: any) =>
      condition.runId?.$in?.includes("generation-7")
    ),
  );
  assert(
    query.$and.some((condition: any) =>
      condition.embeddingSpaceId?.$in?.includes("space-v2")
    ),
  );
  assert(
    query.$and.some((condition: any) =>
      condition.$or?.some((branch: any) =>
        branch.original_id?.$in?.some((value: unknown) =>
          String(value) === recordingId
        )
      )
    ),
  );
  assertEquals(
    query.$and.some((condition: any) => condition.speakerIdentity),
    false,
  );
});

Deno.test("review candidate selection uses active projections and target-aware annotations", () => {
  const automaticIdentity = {
    calibrationId: "sky-r7",
    profileRevision: 7,
    embeddingSpaceId: "space-v2",
    evidenceSnapshotHash: "evidence-7",
    decisionValidity: "verified" as const,
  };
  assert(reviewCandidateMatchesIdentity(
    {
      speakerIdentity: {
        modelSetId: "set-active",
        source: "automatic",
        validity: "verified",
        selectedProfileState: "identified",
      },
    },
    "auto_matched",
    skyProfileId,
    automaticIdentity,
  ));
  assert(reviewCandidateMatchesIdentity(
    {
      speakerIdentity: {
        modelSetId: "set-active",
        selectedProfileState: "ambiguous",
      },
    },
    "reviewable",
    skyProfileId,
  ));
  assertEquals(
    annotationResolvesReviewForProfile({
      profileId: null,
      excludedProfileIds: [otherProfileId],
    }, skyProfileId),
    false,
  );
  assert(annotationResolvesReviewForProfile({
    profileId: otherProfileId,
    excludedProfileIds: [],
  }, skyProfileId));
  assert(annotationResolvesReviewForProfile({
    profileId: null,
    excludedProfileIds: [skyProfileId],
  }, skyProfileId));
});

Deno.test("review source schema keeps discovery permissive and create strict", () => {
  const source = {
    targetProfileIds: [skyProfileId],
    sourceMode: "selected_recordings",
    embeddingSpaceIds: ["space-v2"],
    runIds: [],
    recordingIds: [],
    rangeMode: "fixed",
    start: new Date("2026-08-01T00:00:00Z"),
    end: new Date("2026-08-02T00:00:00Z"),
  };
  const preview = speakerSegmentsRequestSchema.safeParse({
    action: "preview-review-session",
    ...source,
  });
  const create = speakerSegmentsRequestSchema.safeParse({
    action: "create-review-session",
    ...source,
  });

  assert(preview.success);
  assert(!create.success);

  const selected = speakerSegmentsRequestSchema.safeParse({
    action: "create-review-session",
    ...source,
    recordingIds: [recordingId, recordingId],
  });
  assert(selected.success);
  if (selected.success && selected.data.action === "create-review-session") {
    assertEquals(selected.data.recordingIds, [recordingId]);
  }

  const mixed = speakerSegmentsRequestSchema.safeParse({
    action: "create-review-session",
    ...source,
    recordingIds: [recordingId],
    runIds: ["generation-7"],
  });
  assert(!mixed.success);

  const generationWithoutRun = speakerSegmentsRequestSchema.safeParse({
    action: "create-review-session",
    ...source,
    sourceMode: "diarization_generation",
    recordingIds: [],
  });
  assert(!generationWithoutRun.success);

  const timelineWithoutFixedRange = speakerSegmentsRequestSchema.safeParse({
    action: "create-review-session",
    ...source,
    sourceMode: "timeline_range",
    recordingIds: [],
    rangeMode: "all_before",
    start: undefined,
    end: undefined,
  });
  assert(!timelineWithoutFixedRange.success);

  const frozenGeneration = speakerSegmentsRequestSchema.safeParse({
    action: "create-review-session",
    ...source,
    sourceMode: "diarization_generation",
    recordingIds: [],
    runIds: ["generation-7"],
  });
  assert(frozenGeneration.success);
});

Deno.test("automatic-match review query defers identity to active projections", () => {
  const query = buildReviewCandidateQuery(
    new Date("2026-08-01T00:00:00Z"),
    new Date("2026-08-02T00:00:00Z"),
    "auto_matched",
    skyProfileId,
    null,
    { embeddingSpaceIds: ["space-v2"] },
    {
      calibrationId: "sky-r7",
      profileRevision: 7,
      embeddingSpaceId: "space-v2",
      evidenceSnapshotHash: "evidence-r7",
      decisionValidity: "verified",
    },
  ) as any;
  assertEquals(JSON.stringify(query).includes("speakerIdentity"), false);
  const provisional = buildReviewCandidateQuery(
    new Date("2026-08-01T00:00:00Z"),
    new Date("2026-08-02T00:00:00Z"),
    "auto_matched",
    skyProfileId,
    null,
    { embeddingSpaceIds: ["space-v2"] },
    {
      calibrationId: "sky-pilot",
      profileRevision: 7,
      embeddingSpaceId: "space-v2",
      evidenceSnapshotHash: "evidence-pilot",
      decisionValidity: "provisional",
    },
  ) as any;
  assertEquals(JSON.stringify(provisional).includes("speakerIdentity"), false);
  assertThrows(() =>
    buildReviewCandidateQuery(
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-02T00:00:00Z"),
      "auto_matched",
    )
  );
});

Deno.test("automatic-match review uses only fresh calibration evidence at the profile head", async () => {
  const headCalibration = {
    calibrationId: "sky-head",
    profileId: skyProfileId,
    profileRevision: 7,
    embeddingSpaceId: "space-v2",
    status: "validated",
    lifecycleStatus: "active",
    serverComputed: true,
    contractVersion: "server-computed-v1",
    computedBy: "speaker-segments",
    classificationPolicy: "full",
    evidenceSnapshotHash: "head-evidence",
    evidenceRevision: 3,
    positiveThreshold: 0.7,
    negativeThreshold: 0.35,
    targetPrecision: 0.98,
    validationMetrics: {
      positivePrecision: 0.99,
      negativePrecision: 0.99,
      identified: 20,
      rejected: 20,
      positives: 20,
      negatives: 20,
    },
    calibrationRecordingIds: ["learn"],
    validationRecordingIds: ["check"],
  };
  const profile = {
    _id: skyProfileId,
    name: "Sky",
    revision: 7,
    embeddingSpaceId: "space-v2",
    activeCalibrationIds: { full: headCalibration.calibrationId },
    calibrationHeadsInitialized: true,
    calibrationEvidenceRevision: 3,
  };
  const mongo = async (request: any) => {
    if (request.collection === "speaker_profiles") return profile;
    if (request.collection === "identity_model_set_heads") return null;
    if (request.collection === "speaker_calibrations") {
      return [
        {
          ...headCalibration,
          calibrationId: "newer-lifecycle-orphan",
          evidenceSnapshotHash: "orphan-evidence",
        },
        headCalibration,
      ];
    }
    throw new Error(`Unexpected Mongo request: ${request.collection}`);
  };
  const resolved = await resolveReviewCandidateContext(
    mongo,
    skyProfileId,
    ["space-v2"],
    {
      sourceMode: "all_matching",
      runIds: [],
      candidateMode: "auto_matched",
    },
  );
  assertEquals(resolved.automaticIdentity?.calibrationId, "sky-head");
  assertEquals(
    resolved.automaticIdentity?.evidenceSnapshotHash,
    "head-evidence",
  );

  await assertRejects(
    () =>
      resolveReviewCandidateContext(
        async (request: any) => {
          if (request.collection === "speaker_profiles") {
            return { ...profile, calibrationEvidenceRevision: 4 };
          }
          if (request.collection === "identity_model_set_heads") return null;
          if (request.collection === "speaker_calibrations") {
            return [headCalibration];
          }
          throw new Error(`Unexpected Mongo request: ${request.collection}`);
        },
        skyProfileId,
        ["space-v2"],
        {
          sourceMode: "all_matching",
          runIds: [],
          candidateMode: "auto_matched",
        },
      ),
    Error,
    "current server-validated calibration",
  );
});

Deno.test("automatic-match review accepts the active model-set projection without a legacy calibration head", async () => {
  const resolved = await resolveReviewCandidateContext(
    async (request: any) => {
      if (request.collection === "speaker_profiles") {
        return {
          _id: skyProfileId,
          name: "Sky",
          revision: 8,
          embeddingSpaceId: "space-v2",
        };
      }
      if (request.collection === "identity_model_set_heads") {
        return { activeModelSetId: "set-current" };
      }
      if (request.collection === "identity_model_sets") {
        return {
          modelSetId: "set-current",
          profileIds: [skyProfileId, otherProfileId],
          staleProfileIds: [],
          status: "active",
        };
      }
      throw new Error(`Unexpected Mongo request: ${request.collection}`);
    },
    skyProfileId,
    ["space-v2"],
    {
      sourceMode: "all_matching",
      runIds: [],
      candidateMode: "auto_matched",
    },
  );

  assertEquals(resolved.automaticIdentity, null);
  assertEquals(resolved.embeddingSpaceIds, ["space-v2"]);
});

Deno.test("review scan cursor and cap use raw candidates before exclusions", () => {
  const raw = [
    { _id: "raw-a", start: new Date("2026-08-01T00:00:00Z") },
    { _id: "raw-b", start: new Date("2026-08-01T00:00:01Z") },
  ];
  assertEquals(buildReviewScanMetadata(raw, 2), {
    rawScannedCount: 2,
    capped: true,
    nextCursor: { start: raw[1].start, segmentId: "raw-b" },
  });
});

Deno.test("review generation resolution requires an active compatible run", async () => {
  const requests: any[] = [];
  const mongo = async (request: any) => {
    requests.push(request);
    if (request.collection === "speaker_profiles") {
      return {
        _id: skyProfileId,
        name: "Sky",
        revision: 7,
        embeddingSpaceId: "space-v2",
      };
    }
    if (request.collection === "diarization_runs") {
      return {
        runId: "generation-7",
        status: "active",
        embeddingSpaceId: "space-v2",
      };
    }
    throw new Error("Unexpected Mongo request");
  };
  const resolved = await resolveReviewCandidateContext(
    mongo,
    skyProfileId,
    ["space-v2"],
    {
      sourceMode: "diarization_generation",
      runIds: ["generation-7"],
      candidateMode: "reviewable",
    },
  );
  assertEquals(resolved.embeddingSpaceIds, ["space-v2"]);
  assert(
    requests.some((request) => request.collection === "diarization_runs"),
  );

  await assertRejects(() =>
    resolveReviewCandidateContext(
      async (request: any) => {
        if (request.collection === "speaker_profiles") {
          return {
            name: "Sky",
            revision: 7,
            embeddingSpaceId: "space-v2",
          };
        }
        return {
          runId: "generation-7",
          status: "ready",
          embeddingSpaceId: "space-v2",
        };
      },
      skyProfileId,
      ["space-v2"],
      {
        sourceMode: "diarization_generation",
        runIds: ["generation-7"],
        candidateMode: "reviewable",
      },
    )
  );
});

Deno.test("clean review candidates exclude sub-second fragments and overlapping duplicates", () => {
  const prepared = prepareReviewCandidates([
    {
      _id: "short",
      original_id: "recording-a",
      runId: "legacy-v0",
      start: new Date("2026-08-12T08:00:00.000Z"),
      end: new Date("2026-08-12T08:00:00.200Z"),
    },
    {
      _id: "contained",
      original_id: "recording-a",
      runId: "legacy-v0",
      start: new Date("2026-08-12T08:00:01.000Z"),
      end: new Date("2026-08-12T08:00:03.000Z"),
    },
    {
      _id: "canonical",
      original_id: "recording-a",
      runId: "legacy-v0",
      start: new Date("2026-08-12T08:00:01.100Z"),
      end: new Date("2026-08-12T08:00:04.000Z"),
    },
  ]);

  assertEquals(prepared.candidates.map((item) => item._id), ["canonical"]);
  assertEquals(prepared.candidates[0].reviewQuality?.duplicateCount, 1);
  assertEquals(prepared.stats.shortExcluded, 1);
  assertEquals(prepared.stats.duplicateExcluded, 1);
});

Deno.test("a skipped review item can be corrected to a speaker label", () => {
  const revised = applyReviewDecisionRevision([
    {
      segmentId,
      status: "skipped",
      decisionId: "66b000000000000000000099",
    },
  ], {
    segmentIds: [segmentId],
    replacesDecisionId: "66b000000000000000000099",
    decisionId: "66b000000000000000000100",
  });

  assertEquals(revised, [{
    segmentId,
    status: "reviewed",
    decisionId: "66b000000000000000000100",
  }]);
  assert(
    speakerSegmentsRequestSchema.safeParse({
      action: "commit-review-skip",
      sessionId,
      revision: 2,
      clientRequestId: "correct-to-noise",
      segmentIds: [segmentId],
      replacesDecisionId: "66b000000000000000000099",
    }).success,
  );
});

Deno.test("calibration save accepts evidence selection but rejects client metrics", () => {
  const request = {
    action: "save-calibration",
    profileId: skyProfileId,
    calibrationRecordingIds: ["fit-recording"],
    validationRecordingIds: ["check-recording"],
    targetPrecision: 0.98,
  };
  assert(speakerSegmentsRequestSchema.safeParse(request).success);
  assertEquals(
    speakerSegmentsRequestSchema.safeParse({
      ...request,
      calibrationId: "client-chosen",
      metrics: { precision: 1, sky: 40, notSky: 40 },
    }).success,
    false,
  );
  assertEquals(
    speakerSegmentsRequestSchema.safeParse({
      ...request,
      targetPrecision: 0.95,
    }).success,
    false,
  );
  assert(
    speakerSegmentsRequestSchema.safeParse({
      ...request,
      targetPrecision: 0.95,
      acceptLowerPrecisionRisk: true,
      positiveThresholdOverride: 0.3,
    }).success,
  );
  assertEquals(
    speakerSegmentsRequestSchema.safeParse({
      ...request,
      positiveThresholdOverride: 0.3,
    }).success,
    false,
  );
  assertEquals(
    speakerSegmentsRequestSchema.safeParse({
      ...request,
      targetPrecision: 0.89,
      acceptLowerPrecisionRisk: true,
    }).success,
    false,
  );
  assertEquals(
    speakerSegmentsRequestSchema.safeParse({
      action: "calibration-preview",
      profileId: skyProfileId,
      targetPrecision: 0.98,
      positiveThresholdOverride: 0.3,
    }).success,
    false,
  );
  assert(
    speakerSegmentsRequestSchema.safeParse({
      action: "calibration-preview",
      profileId: skyProfileId,
      targetPrecision: 0.95,
      positiveThresholdOverride: 0.3,
    }).success,
  );
});
