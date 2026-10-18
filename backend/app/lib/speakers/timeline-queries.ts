export const TIMELINE_SPEAKER_SEGMENT_PROJECTION = {
  _id: 1,
  start: 1,
  end: 1,
  original_id: 1,
  original: 1,
  runId: 1,
  embeddingSpaceId: 1,
  speakerIdentity: 1,
  matched_speaker: 1,
} as const;

export function buildDiarizationCoveragePipeline(
  start: Date,
  end: Date,
  bucketMs: number,
): Record<string, unknown>[] {
  return [
    {
      $match: {
        "vad.has_speech": true,
        start: { $gte: start, $lt: end },
      },
    },
    {
      $project: {
        _id: 0,
        bucket: {
          $multiply: [{
            $floor: {
              $divide: [{ $toLong: "$start" }, bucketMs],
            },
          }, bucketMs],
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
    },
    {
      $group: {
        _id: { bucket: "$bucket", state: "$state" },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.bucket": 1 } },
  ];
}

export function buildSpeakerTimelinePipeline(input: {
  start: Date;
  end: Date;
  detail: "intervals" | "buckets";
  bucketMs?: number;
  targetProfileId: unknown;
  modelSetId?: string | null;
  targetProfileIncluded?: boolean;
  states?: Array<
    | "identified"
    | "ambiguous"
    | "unknown"
    | "matched"
    | "rejected"
    | "uncertain"
    | "unclassified"
  >;
  validities?: Array<"verified" | "provisional" | "manual">;
  inclusion?: "selected_only" | "includes_candidate";
  sources?: Array<"manual" | "automatic">;
}): Record<string, unknown>[] {
  if (input.detail === "buckets" && !input.bucketMs) {
    throw new Error("Far Timeline summary requires bucketMs");
  }
  const target = String(input.targetProfileId);
  const automaticEnabled = Boolean(
    input.modelSetId && input.targetProfileIncluded,
  );
  const targetIdList = (field: string) => ({
    $map: {
      input: { $ifNull: [field, []] },
      as: "candidate",
      in: { $toString: "$$candidate.profileId" },
    },
  });
  const excludedIdList = {
    $map: {
      input: { $ifNull: ["$_manual.excludedProfileIds", []] },
      as: "profileId",
      in: { $toString: "$$profileId" },
    },
  };
  const pipeline: Record<string, unknown>[] = [
    {
      $match: {
        lifecycleStatus: "active",
        start: { $lt: input.end },
        end: { $gt: input.start },
      },
    },
    {
      $lookup: {
        from: "speaker_annotations",
        let: {
          segmentId: "$_id",
          originalId: { $ifNull: ["$original_id", "$original"] },
          segmentStart: "$start",
          segmentEnd: "$end",
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: ["$segmentId", "$$segmentId"] },
                  {
                    $and: [
                      { $eq: ["$originalId", "$$originalId"] },
                      { $lt: ["$start", "$$segmentEnd"] },
                      { $gt: ["$end", "$$segmentStart"] },
                    ],
                  },
                ],
              },
            },
          },
          {
            // A negative label for an unrelated profile must not hide an
            // older label for the selected profile. Any positive assignment
            // remains relevant because assigning the segment to another
            // speaker is an explicit negative result for this profile.
            $match: {
              $expr: {
                $or: [
                  {
                    $ne: [{ $ifNull: ["$profileId", null] }, null],
                  },
                  {
                    $in: [target, {
                      $map: {
                        input: { $ifNull: ["$excludedProfileIds", []] },
                        as: "profileId",
                        in: { $toString: "$$profileId" },
                      },
                    }],
                  },
                ],
              },
            },
          },
          { $sort: { updatedAt: -1, createdAt: -1 } },
          { $limit: 1 },
          { $project: { profileId: 1, excludedProfileIds: 1 } },
        ],
        as: "_manualAnnotations",
      },
    },
    {
      $lookup: {
        from: "speaker_identity_projections",
        let: { segmentId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: input.modelSetId
                ? {
                  $and: [
                    { $eq: ["$segmentId", "$$segmentId"] },
                    { $eq: ["$modelSetId", input.modelSetId] },
                  ],
                }
                : { $eq: [1, 0] },
            },
          },
          { $limit: 1 },
          {
            $project: {
              resolution: 1,
              profileId: 1,
              candidates: 1,
              complete: 1,
              source: 1,
              topTwoMargin: 1,
            },
          },
        ],
        as: "_identityProjections",
      },
    },
    {
      $set: {
        _manual: { $first: "$_manualAnnotations" },
        _projection: { $first: "$_identityProjections" },
      },
    },
    {
      $set: {
        _manualProfileId: {
          $cond: [
            { $ne: [{ $ifNull: ["$_manual.profileId", null] }, null] },
            { $toString: "$_manual.profileId" },
            null,
          ],
        },
        _manualExcludedSelected: { $in: [target, excludedIdList] },
        _matchedCandidates: {
          $filter: {
            input: { $ifNull: ["$_projection.candidates", []] },
            as: "candidate",
            cond: { $eq: ["$$candidate.state", "matched"] },
          },
        },
        _uncertainCandidates: {
          $filter: {
            input: { $ifNull: ["$_projection.candidates", []] },
            as: "candidate",
            cond: { $eq: ["$$candidate.state", "uncertain"] },
          },
        },
        _selectedCandidate: {
          $first: {
            $filter: {
              input: { $ifNull: ["$_projection.candidates", []] },
              as: "candidate",
              cond: {
                $eq: [{ $toString: "$$candidate.profileId" }, target],
              },
            },
          },
        },
      },
    },
    {
      $set: {
        _manualSelected: { $eq: ["$_manualProfileId", target] },
        _manualOther: {
          $and: [
            { $ne: ["$_manualProfileId", null] },
            { $ne: ["$_manualProfileId", target] },
          ],
        },
        _automaticAvailable: {
          $and: [automaticEnabled, { $ne: ["$_projection", null] }],
        },
        _automaticResolution: {
          $switch: {
            branches: [
              {
                case: { $ne: ["$_projection.complete", true] },
                then: "unclassified",
              },
              {
                case: { $eq: [{ $size: "$_matchedCandidates" }, 1] },
                then: "identified",
              },
              {
                case: { $gt: [{ $size: "$_matchedCandidates" }, 1] },
                then: "ambiguous",
              },
              {
                case: { $gt: [{ $size: "$_uncertainCandidates" }, 0] },
                then: "uncertain",
              },
            ],
            default: "unknown",
          },
        },
        _automaticProfileId: {
          $cond: [
            { $eq: [{ $size: "$_matchedCandidates" }, 1] },
            {
              $toString: {
                $arrayElemAt: ["$_matchedCandidates.profileId", 0],
              },
            },
            null,
          ],
        },
      },
    },
    {
      $project: {
        _id: 1,
        start: 1,
        end: 1,
        originalId: { $ifNull: ["$original_id", "$original"] },
        state: {
          $switch: {
            branches: [
              {
                case: "$_manualSelected",
                then: "identified",
              },
              {
                case: {
                  $or: ["$_manualOther", "$_manualExcludedSelected"],
                },
                then: "unknown",
              },
              {
                case: {
                  $and: [
                    "$_automaticAvailable",
                    { $eq: ["$_automaticResolution", "identified"] },
                    { $eq: ["$_automaticProfileId", target] },
                  ],
                },
                then: "identified",
              },
              {
                case: {
                  $and: [
                    "$_automaticAvailable",
                    { $eq: ["$_automaticResolution", "ambiguous"] },
                    {
                      $in: [target, targetIdList("$_matchedCandidates")],
                    },
                  ],
                },
                then: "ambiguous",
              },
              {
                case: {
                  $and: [
                    "$_automaticAvailable",
                    { $eq: ["$_automaticResolution", "uncertain"] },
                    {
                      $in: [target, targetIdList("$_uncertainCandidates")],
                    },
                  ],
                },
                then: "uncertain",
              },
              {
                case: "$_automaticAvailable",
                then: {
                  $cond: [
                    { $eq: ["$_automaticResolution", "unclassified"] },
                    "unclassified",
                    "unknown",
                  ],
                },
              },
            ],
            default: "unclassified",
          },
        },
        validity: {
          $switch: {
            branches: [
              {
                case: {
                  $or: [
                    "$_manualSelected",
                    "$_manualOther",
                    "$_manualExcludedSelected",
                  ],
                },
                then: "manual",
              },
              { case: "$_automaticAvailable", then: "verified" },
            ],
            default: null,
          },
        },
        source: {
          $switch: {
            branches: [
              {
                case: {
                  $or: [
                    "$_manualSelected",
                    "$_manualOther",
                    "$_manualExcludedSelected",
                  ],
                },
                then: "manual",
              },
              { case: "$_automaticAvailable", then: "automatic" },
            ],
            default: null,
          },
        },
        profileId: {
          $cond: [
            "$_manualSelected",
            target,
            {
              $cond: [
                {
                  $and: [
                    "$_automaticAvailable",
                    { $eq: ["$_automaticResolution", "identified"] },
                    { $eq: ["$_automaticProfileId", target] },
                  ],
                },
                target,
                null,
              ],
            },
          ],
        },
        score: {
          $cond: [
            "$_automaticAvailable",
            { $ifNull: ["$_selectedCandidate.score", null] },
            null,
          ],
        },
        candidates: {
          $cond: [
            "$_automaticAvailable",
            { $ifNull: ["$_projection.candidates", []] },
            [],
          ],
        },
        includesSelectedCandidate: {
          $or: [
            "$_manualSelected",
            {
              $and: [
                "$_automaticAvailable",
                {
                  $in: [
                    target,
                    targetIdList("$_projection.candidates"),
                  ],
                },
              ],
            },
          ],
        },
        modelSetId: {
          $cond: ["$_automaticAvailable", input.modelSetId ?? null, null],
        },
      },
    },
  ];
  const filtered: Record<string, unknown> = {};
  if (input.states?.length) {
    filtered.state = {
      $in: [
        ...new Set(
          input.states.map((state) =>
            state === "matched"
              ? "identified"
              : state === "rejected"
              ? "unknown"
              : state
          ),
        ),
      ],
    };
  }
  if (input.validities?.length) filtered.validity = { $in: input.validities };
  if (input.sources?.length) filtered.source = { $in: input.sources };
  if (input.inclusion === "selected_only") filtered.state = "identified";
  if (input.inclusion === "includes_candidate") {
    filtered.includesSelectedCandidate = true;
  }
  if (Object.keys(filtered).length > 0) pipeline.push({ $match: filtered });

  if (input.detail === "intervals") {
    pipeline.push({ $sort: { start: 1, _id: 1 } }, { $limit: 10_001 });
    return pipeline;
  }
  pipeline.push(
    {
      $set: {
        bucket: {
          $multiply: [{
            $floor: {
              $divide: [{ $toLong: "$start" }, input.bucketMs],
            },
          }, input.bucketMs],
        },
        durationMs: {
          $max: [0, { $subtract: ["$end", "$start"] }],
        },
      },
    },
    {
      $group: {
        _id: "$bucket",
        segments: { $sum: 1 },
        identified: {
          $sum: { $cond: [{ $eq: ["$state", "identified"] }, 1, 0] },
        },
        ambiguous: {
          $sum: { $cond: [{ $eq: ["$state", "ambiguous"] }, 1, 0] },
        },
        unknown: {
          $sum: { $cond: [{ $eq: ["$state", "unknown"] }, 1, 0] },
        },
        uncertain: {
          $sum: { $cond: [{ $eq: ["$state", "uncertain"] }, 1, 0] },
        },
        identifiedMs: {
          $sum: {
            $cond: [{ $eq: ["$state", "identified"] }, "$durationMs", 0],
          },
        },
        ambiguousMs: {
          $sum: {
            $cond: [{ $eq: ["$state", "ambiguous"] }, "$durationMs", 0],
          },
        },
        uncertainMs: {
          $sum: {
            $cond: [{ $eq: ["$state", "uncertain"] }, "$durationMs", 0],
          },
        },
        unclassifiedMs: {
          $sum: {
            $cond: [{ $eq: ["$state", "unclassified"] }, "$durationMs", 0],
          },
        },
        unclassified: {
          $sum: { $cond: [{ $eq: ["$state", "unclassified"] }, 1, 0] },
        },
        verified: {
          $sum: { $cond: [{ $eq: ["$validity", "verified"] }, 1, 0] },
        },
        provisional: {
          $sum: { $cond: [{ $eq: ["$validity", "provisional"] }, 1, 0] },
        },
        manual: { $sum: { $cond: [{ $eq: ["$validity", "manual"] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  );
  return pipeline;
}

export function buildIdentityClassificationSummaryPipeline(input: {
  asOf: Date;
  targetProfileId: unknown;
  modelSetId?: string | null;
  targetProfileIncluded?: boolean;
}): Record<string, unknown>[] {
  const pipeline = buildSpeakerTimelinePipeline({
    start: new Date(0),
    end: input.asOf,
    detail: "intervals",
    targetProfileId: input.targetProfileId,
    modelSetId: input.modelSetId,
    targetProfileIncluded: input.targetProfileIncluded,
  });
  // The shared projection stages already enforce active-segment membership,
  // selected-profile semantics, and manual precedence. Replace the UI page
  // sort/limit with an exact corpus-wide aggregate.
  pipeline.splice(-2, 2);
  pipeline.push({
    $group: {
      _id: null,
      identified: {
        $sum: { $cond: [{ $eq: ["$state", "identified"] }, 1, 0] },
      },
      unknown: {
        $sum: { $cond: [{ $eq: ["$state", "unknown"] }, 1, 0] },
      },
      uncertain: {
        $sum: {
          $cond: [{ $in: ["$state", ["uncertain", "ambiguous"]] }, 1, 0],
        },
      },
      unclassified: {
        $sum: { $cond: [{ $eq: ["$state", "unclassified"] }, 1, 0] },
      },
      verified: {
        $sum: { $cond: [{ $eq: ["$validity", "verified"] }, 1, 0] },
      },
      manual: {
        $sum: { $cond: [{ $eq: ["$validity", "manual"] }, 1, 0] },
      },
    },
  });
  return pipeline;
}
