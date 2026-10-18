import { describe, expect, it } from "vitest";
import { coverageColor } from "./diarizationCoverage";
import {
  DIARIZATION_COVERAGE_LEGEND,
  SPEAKER_IDENTITY_LEGEND,
  SPEAKER_IDENTITY_VALIDITY_LEGEND,
  speakerIdentityAppearance,
} from "./timelineDiarization";

describe("Timeline diarization colors", () => {
  it("keeps the speaker legend aligned with rendered segment colors", () => {
    for (const item of SPEAKER_IDENTITY_LEGEND) {
      expect(speakerIdentityAppearance(item.id)).toEqual(item);
    }
    expect(speakerIdentityAppearance("unknown").label).toBe(
      "Other / unknown",
    );
  });

  it("uses the selected profile color and hatching for ambiguous candidates", () => {
    expect(speakerIdentityAppearance("ambiguous", "verified", {
      name: "Belka",
      color: "#123456",
    })).toMatchObject({
      id: "ambiguous",
      label: "Belka is a candidate",
      color: "#123456",
      pattern: "diagonal",
      strokeDasharray: "3 2",
    });
  });

  it("visibly distinguishes provisional pilot decisions", () => {
    const verified = speakerIdentityAppearance("matched", "verified");
    const provisional = speakerIdentityAppearance("matched", "provisional");

    expect(provisional).toMatchObject({
      label: "Pilot · Sky",
      color: verified.color,
      stroke: "#a855f7",
      strokeDasharray: "4 2",
    });
    expect(provisional.opacity).toBeLessThan(verified.opacity);
    expect(SPEAKER_IDENTITY_VALIDITY_LEGEND[0]).toMatchObject({
      id: "provisional",
      stroke: "#a855f7",
    });
  });

  it("keeps the coverage legend aligned with coverage colors", () => {
    for (
      const state of [
        "diarized",
        "processing",
        "pending",
        "needs_attention",
      ] as const
    ) {
      expect(
        DIARIZATION_COVERAGE_LEGEND.find((item) => item.id === state)?.color,
      ).toBe(coverageColor(state));
    }
  });
});
