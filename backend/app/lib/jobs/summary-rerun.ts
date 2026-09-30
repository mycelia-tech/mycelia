import { ObjectId } from "bson";
import { z } from "zod";

export const ReprocessModelArtifactsSchema = z.object({
  action: z.literal("reprocess_model_artifacts"),
  artifactType: z.literal("summary"),
  sourceModel: z.string().min(1).optional(),
  targetModel: z.string().min(1),
  targetProviderProfileId: z.string().min(1).optional(),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
  afterObjectId: z.string().regex(/^[a-fA-F0-9]{24}$/).optional(),
  artifactIds: z.array(
    z.string().refine((id) => /^[a-fA-F0-9]{24}$/.test(id.split(":", 1)[0])),
  ).min(1).max(100).optional(),
  limit: z.number().int().min(1).max(100).default(25),
}).superRefine((value, ctx) => {
  if ((value.start == null) !== (value.end == null)) {
    ctx.addIssue({ code: "custom", message: "Provide both start and end" });
  }
  if (
    value.start && value.end && new Date(value.start) >= new Date(value.end)
  ) {
    ctx.addIssue({ code: "custom", message: "End must be after start" });
  }
  if (
    (!value.sourceModel || value.sourceModel === "all") && !value.start &&
    !value.artifactIds?.length
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Choose a date range or explicit summaries for all models",
    });
  }
});

const executedModel = {
  $ifNull: ["$$summary.resolvedModel", {
    $ifNull: ["$$summary.modelName", "$$summary.model"],
  }],
};

/** Match the date and source model on the same summary version. */
export function buildSummaryRerunPipeline(
  input: z.infer<typeof ReprocessModelArtifactsSchema>,
): Record<string, unknown>[] {
  const sourceConditions: Record<string, unknown>[] = [];
  if (input.sourceModel && input.sourceModel !== "all") {
    sourceConditions.push({ $eq: [executedModel, input.sourceModel] });
  }
  if (input.start && input.end) {
    sourceConditions.push(
      { $gte: ["$$summary.date", new Date(input.start)] },
      { $lt: ["$$summary.date", new Date(input.end)] },
    );
  }
  const targetConditions: Record<string, unknown>[] = [{
    $or: [
      { $eq: [executedModel, input.targetModel] },
      { $eq: ["$$summary.requestedModel", input.targetModel] },
    ],
  }];
  if (input.targetProviderProfileId) {
    targetConditions.push({
      $eq: [
        "$$summary.provenance.providerProfileId",
        input.targetProviderProfileId,
      ],
    });
  }
  const anySummary = (conditions: Record<string, unknown>[]) => ({
    $anyElementTrue: [{
      $map: {
        input: { $ifNull: ["$summaries", []] },
        as: "summary",
        in: { $and: conditions },
      },
    }],
  });
  return [
    {
      $match: {
        isConversation: true,
        "summaries.0": { $exists: true },
        ...(input.artifactIds || input.afterObjectId
          ? {
            _id: {
              ...(input.artifactIds
                ? {
                  $in: input.artifactIds.map((id) =>
                    new ObjectId(id.split(":", 1)[0])
                  ),
                }
                : {}),
              ...(input.afterObjectId
                ? { $gt: new ObjectId(input.afterObjectId) }
                : {}),
            },
          }
          : {}),
        $expr: {
          $and: [anySummary(sourceConditions), {
            $not: [anySummary(targetConditions)],
          }],
        },
      },
    },
    { $sort: { _id: 1 } },
    { $limit: input.limit },
    { $project: { _id: 1 } },
  ];
}
