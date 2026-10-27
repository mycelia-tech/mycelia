import { describe, expect, it } from "vitest";
import { buildPendingVoiceProfileRebuildUpdate } from "./voiceProfileRebuild";

describe("voice profile rebuild updates", () => {
  it("leaves the revision for the reenrollment worker to advance once", () => {
    const update = buildPendingVoiceProfileRebuildUpdate(
      3,
      new Date("2026-10-18T09:00:00.000Z"),
    );

    expect(update).toEqual({
      $set: {
        sample_count: 3,
        enrollmentStatus: "pending_rebuild",
        updated_at: "2026-10-18T09:00:00.000Z",
      },
      $unset: { embedding: "" },
    });
    expect(update.$set).not.toHaveProperty("revision");
  });
});
