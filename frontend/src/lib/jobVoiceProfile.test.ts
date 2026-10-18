import { describe, expect, it } from "vitest";
import { resolveJobVoiceProfileContext } from "./jobVoiceProfile";

function job(data: any, result: any = {}) {
  return {
    id: "job-1",
    type: "speakerIdentity",
    data,
    result,
    state: "completed",
    progress: {},
    timestamp: 1,
  };
}

describe("job voice profile context", () => {
  it("uses the job model-set snapshots instead of an unrelated URL profile", () => {
    expect(resolveJobVoiceProfileContext(
      job({
        profileIds: [
          "66b000000000000000000010",
          "66b000000000000000000020",
        ],
        profileSnapshots: [
          { profileId: "66b000000000000000000010", name: "Sky" },
          { profileId: "66b000000000000000000020", name: "Belka" },
        ],
      }),
      "66b000000000000000000099",
    )).toEqual({
      profileIds: [
        "66b000000000000000000010",
        "66b000000000000000000020",
      ],
      primaryProfileId: "66b000000000000000000010",
      label: "Sky, Belka",
    });
  });

  it("falls back to the selected profile only for legacy jobs", () => {
    expect(
      resolveJobVoiceProfileContext(
        job({}),
        "66b000000000000000000099",
      ).primaryProfileId,
    ).toBe("66b000000000000000000099");
  });
});
