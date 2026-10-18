import { describe, expect, it } from "vitest";
import {
  buildSpeakerProfileDirectory,
  resolveSpeakerIdentityDisplay,
} from "./speakerIdentityDisplay";

const skyId = "698349a50dadb6125cb83312";
const belkaId = "698349a50dadb6125cb83313";
const profiles = buildSpeakerProfileDirectory([
  { _id: skyId, name: "Sky", color: "#111111" },
  {
    _id: belkaId,
    name: "Belka",
    color: "#222222",
    lifecycleStatus: "archived",
  },
]);

describe("speaker identity display", () => {
  it("uses canonical identity profile before a conflicting legacy match", () => {
    const result = resolveSpeakerIdentityDisplay({
      identity: {
        state: "matched",
        identityState: "identified",
        profileId: belkaId,
        primaryScore: 0.91,
      },
      legacyMatchedSpeaker: {
        profile_id: skyId,
        name: "Sky",
        similarity: 0.99,
      },
      profiles,
    });

    expect(result.label).toBe("Belka");
    expect(result.profile).toMatchObject({
      id: belkaId,
      name: "Belka",
      archived: true,
    });
    expect(result.score).toBe(0.91);
  });

  it("falls back to the legacy matched speaker without inventing Sky", () => {
    const result = resolveSpeakerIdentityDisplay({
      legacyMatchedSpeaker: {
        profile_id: belkaId,
        name: "Belka",
        similarity: 0.82,
      },
      profiles,
    });

    expect(result.resolution).toBe("identified");
    expect(result.label).toBe("Belka");
  });

  it("names the evaluated profile for rejected and uncertain decisions", () => {
    const rejected = resolveSpeakerIdentityDisplay({
      identity: {
        state: "rejected",
        topCandidate: { profileId: belkaId, score: 0.1 },
      },
      profiles,
    });
    const uncertain = resolveSpeakerIdentityDisplay({
      identity: { state: "uncertain" },
      profiles,
      selectedProfileId: skyId,
    });

    expect(rejected.label).toBe("Not Belka");
    expect(uncertain.label).toBe("Uncertain: Sky");
  });

  it("keeps every candidate when a future model set is ambiguous", () => {
    const result = resolveSpeakerIdentityDisplay({
      identity: {
        identityState: "ambiguous",
        candidates: [
          { profileId: skyId, score: 0.82 },
          { profileId: belkaId, score: 0.8 },
        ],
      },
      profiles,
    });

    expect(result.profile).toBeNull();
    expect(result.label).toBe("Ambiguous: Sky / Belka");
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      skyId,
      belkaId,
    ]);
  });

  it("does not make an unclassified segment look related to the selected voice", () => {
    const result = resolveSpeakerIdentityDisplay({
      identity: { identityState: "unclassified" },
      profiles,
      selectedProfileId: skyId,
    });

    expect(result.resolution).toBe("unclassified");
    expect(result.evaluatedProfile).toBeNull();
  });

  it("does not revive a legacy match when the active model set is unclassified", () => {
    const result = resolveSpeakerIdentityDisplay({
      identity: {
        modelSetId: "set-current",
        identityState: "unclassified",
        selectedProfileState: "unclassified",
        evaluatedProfileId: skyId,
      },
      legacyMatchedSpeaker: {
        profile_id: skyId,
        name: "Sky",
        similarity: 0.99,
      },
      profiles,
      selectedProfileId: skyId,
    });

    expect(result.resolution).toBe("unclassified");
    expect(result.selectedResolution).toBe("unclassified");
    expect(result.profile).toBeNull();
  });

  it("keeps the actual winner while filtering it as not the selected voice", () => {
    const result = resolveSpeakerIdentityDisplay({
      identity: {
        modelSetId: "set-current",
        identityState: "identified",
        selectedProfileState: "unknown",
        profileId: belkaId,
        evaluatedProfileId: skyId,
        candidates: [{ profileId: belkaId, score: 0.91 }],
      },
      profiles,
      selectedProfileId: skyId,
    });

    expect(result.resolution).toBe("identified");
    expect(result.profile?.name).toBe("Belka");
    expect(result.selectedResolution).toBe("rejected");
  });

  it("lets a manual projection override stale automatic ambiguity", () => {
    const result = resolveSpeakerIdentityDisplay({
      identity: {
        source: "manual_projection",
        state: "matched",
        identityState: "ambiguous",
        profileId: belkaId,
        candidates: [
          { profileId: skyId, score: 0.82 },
          { profileId: belkaId, score: 0.8 },
        ],
      },
      profiles,
      selectedProfileId: belkaId,
    });

    expect(result.resolution).toBe("identified");
    expect(result.profile?.id).toBe(belkaId);
  });
});
