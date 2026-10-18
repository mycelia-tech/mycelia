export function buildPendingVoiceProfileRebuildUpdate(
  sampleCount: number,
  updatedAt = new Date(),
) {
  return {
    $set: {
      sample_count: sampleCount,
      enrollmentStatus: "pending_rebuild",
      updated_at: updatedAt.toISOString(),
    },
    $unset: { embedding: "" },
  };
}
