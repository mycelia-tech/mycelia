import { assertEquals } from "jsr:@std/assert@^1.0.15";
import {
  buildDiarizationCoveragePipeline,
  buildIdentityClassificationSummaryPipeline,
  buildSpeakerTimelinePipeline,
  TIMELINE_SPEAKER_SEGMENT_PROJECTION,
} from "./timeline-queries.ts";

Deno.test("classification summary shares active projection and manual precedence stages", () => {
  const pipeline = buildIdentityClassificationSummaryPipeline({
    asOf: new Date("2026-08-02T00:00:00Z"),
    targetProfileId: "sky",
    modelSetId: "set-active",
    targetProfileIncluded: true,
  });
  const lookups = pipeline.filter((stage) => "$lookup" in stage) as any[];
  assertEquals(lookups.map((stage) => stage.$lookup.from), [
    "speaker_annotations",
    "speaker_identity_projections",
  ]);
  assertEquals(
    lookups[1].$lookup.pipeline[0].$match.$expr.$and[1],
    { $eq: ["$modelSetId", "set-active"] },
  );
  assertEquals((pipeline.at(-1) as any).$group.identified.$sum, {
    $cond: [{ $eq: ["$state", "identified"] }, 1, 0],
  });
});

Deno.test("coverage query excludes document ids so the coverage index can cover it", () => {
  const pipeline = buildDiarizationCoveragePipeline(
    new Date("2026-08-01T00:00:00.000Z"),
    new Date("2026-08-02T00:00:00.000Z"),
    3_600_000,
  );

  assertEquals(pipeline[1], {
    $project: {
      _id: 0,
      bucket: {
        $multiply: [{
          $floor: {
            $divide: [{ $toLong: "$start" }, 3_600_000],
          },
        }, 3_600_000],
      },
      state: {
        $switch: {
          branches: [
            {
              case: {
                $eq: [
                  "$diarizationFailure.status",
                  "needs_attention",
                ],
              },
              then: "needs_attention",
            },
            {
              case: {
                $ne: [{ $ifNull: ["$processing_by", null] }, null],
              },
              then: "processing",
            },
            {
              case: {
                $ne: [{ $ifNull: ["$diarized_at", null] }, null],
              },
              then: "diarized",
            },
          ],
          default: "pending",
        },
      },
    },
  });
});

Deno.test("speaker timeline reads only the active model-set projection and keeps manual override first", () => {
  const pipeline = buildSpeakerTimelinePipeline({
    start: new Date("2026-08-01T00:00:00Z"),
    end: new Date("2026-08-02T00:00:00Z"),
    detail: "buckets",
    bucketMs: 60_000,
    targetProfileId: "sky-object-id",
    modelSetId: "model-set-active",
    targetProfileIncluded: true,
  });
  assertEquals(pipeline[0], {
    $match: {
      lifecycleStatus: "active",
      $or: [
        {
          start: {
            $gte: new Date("2026-08-01T00:00:00Z"),
            $lt: new Date("2026-08-02T00:00:00Z"),
          },
        },
        {
          start: { $lt: new Date("2026-08-01T00:00:00Z") },
          end: { $gt: new Date("2026-08-01T00:00:00Z") },
        },
      ],
    },
  });
  assertEquals(pipeline[1], {
    $project: TIMELINE_SPEAKER_SEGMENT_PROJECTION,
  });
  const lookups = pipeline.filter((stage) => "$lookup" in stage) as any[];
  assertEquals(lookups.map((stage) => stage.$lookup.from), [
    "speaker_annotations",
    "speaker_identity_projections",
  ]);
  assertEquals(lookups[0].$lookup.pipeline[1].$match.$expr.$or[0], {
    $ne: [{ $ifNull: ["$profileId", null] }, null],
  });
  assertEquals(lookups[0].$lookup.pipeline[2], {
    $sort: { updatedAt: -1, createdAt: -1 },
  });
  assertEquals(lookups[0].$lookup.pipeline[3], { $limit: 1 });
  assertEquals(
    lookups[1].$lookup.pipeline[0].$match.$expr.$and[1],
    { $eq: ["$modelSetId", "model-set-active"] },
  );
  const projection = pipeline.find((stage) =>
    "$project" in stage && (stage as any).$project.state
  ) as any;
  assertEquals(
    projection.$project.state.$switch.branches[0].then,
    "identified",
  );
  assertEquals(
    projection.$project.state.$switch.branches[1].then,
    "unknown",
  );
  assertEquals(pipeline.at(-1), { $sort: { _id: 1 } });
});

Deno.test("speaker timeline keeps manual profile decisions without a calibration snapshot", () => {
  const pipeline = buildSpeakerTimelinePipeline({
    start: new Date("2026-08-01T00:00:00Z"),
    end: new Date("2026-08-02T00:00:00Z"),
    detail: "intervals",
    targetProfileId: "manual-profile-id",
    modelSetId: null,
    targetProfileIncluded: false,
  });

  const projection = pipeline.find((stage) =>
    "$project" in stage && (stage as any).$project.state
  ) as any;
  const stateBranches = projection.$project.state.$switch.branches;
  assertEquals(stateBranches[0], {
    case: "$_manualSelected",
    then: "identified",
  });
  assertEquals(stateBranches[1].then, "unknown");
  assertEquals(
    projection.$project.validity.$switch.branches[0].then,
    "manual",
  );
});

Deno.test("speaker timeline applies selected-profile candidate and source filters", () => {
  const pipeline = buildSpeakerTimelinePipeline({
    start: new Date("2026-08-01T00:00:00Z"),
    end: new Date("2026-08-02T00:00:00Z"),
    detail: "intervals",
    targetProfileId: "belka",
    modelSetId: "model-set-active",
    targetProfileIncluded: true,
    inclusion: "includes_candidate",
    sources: ["automatic"],
    states: ["ambiguous", "uncertain"],
  });
  const filter = pipeline.find((stage) =>
    "$match" in stage &&
    (stage as any).$match.includesSelectedCandidate === true
  ) as any;
  assertEquals(filter.$match, {
    state: { $in: ["ambiguous", "uncertain"] },
    source: { $in: ["automatic"] },
    includesSelectedCandidate: true,
  });
});

Deno.test("Timeline speaker projection omits embeddings and keeps render fields", () => {
  assertEquals(TIMELINE_SPEAKER_SEGMENT_PROJECTION, {
    _id: 1,
    start: 1,
    end: 1,
    original_id: 1,
    original: 1,
    runId: 1,
    embeddingSpaceId: 1,
    speakerIdentity: 1,
    matched_speaker: 1,
  });
});
