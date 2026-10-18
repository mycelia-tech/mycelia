import { describe, expect, it } from "vitest";
import {
  resolveSelectedVoiceProfileId,
  withVoiceProfile,
} from "./voiceProfileNavigation";

const profiles = [
  { id: "sky", isPrimary: true },
  { id: "belka" },
  { id: "archived", archived: true },
];

describe("voice profile navigation", () => {
  it("uses URL, storage, primary and first in that order", () => {
    expect(resolveSelectedVoiceProfileId({
      requestedProfileId: "belka",
      storedProfileId: "sky",
      profiles,
    })).toMatchObject({ selectedProfileId: "belka", source: "url" });
    expect(resolveSelectedVoiceProfileId({
      storedProfileId: "belka",
      profiles,
    })).toMatchObject({ selectedProfileId: "belka", source: "storage" });
    expect(resolveSelectedVoiceProfileId({ profiles })).toMatchObject({
      selectedProfileId: "sky",
      source: "primary",
    });
    expect(resolveSelectedVoiceProfileId({
      profiles: [{ id: "belka" }],
    })).toMatchObject({ selectedProfileId: "belka", source: "first" });
  });

  it("keeps an invalid explicit URL visible instead of silently falling back", () => {
    expect(resolveSelectedVoiceProfileId({
      requestedProfileId: "archived",
      storedProfileId: "sky",
      profiles,
    })).toEqual({
      selectedProfileId: null,
      invalidRequestedProfileId: "archived",
      source: "none",
    });
  });

  it("adds a profile without dropping range, filters, or hash", () => {
    expect(withVoiceProfile(
      "/timeline?start=10&end=20&speakerIdentity=ambiguous#voices",
      "belka",
    )).toBe(
      "/timeline?start=10&end=20&speakerIdentity=ambiguous&profileId=belka#voices",
    );
  });
});
