import { describe, expect, it } from "vitest";
import {
  buildSpeakerIdentityCampaignRequest,
  buildSpeakerIdentityPreflightRequest,
  shortTechnicalId,
  type SpeakerIdentityPreflight,
  speakerIdentityPreflightState,
} from "./speakerIdentityLaunch";

describe("speaker identity campaign contract", () => {
  it("keeps automatic resolution on the server for full-history campaigns", () => {
    const scope = { mode: "all_compatible" as const };

    expect(buildSpeakerIdentityPreflightRequest("sky-id", scope)).toEqual({
      action: "identity-preflight",
      profileId: "sky-id",
      scope,
    });
    expect(
      buildSpeakerIdentityCampaignRequest("sky-id", "snapshot-1"),
    ).toEqual({
      action: "start-identity-campaign",
      profileId: "sky-id",
      preflightToken: "snapshot-1",
    });
  });

  it("supports an advanced bounded range without exposing run selection", () => {
    const scope = {
      mode: "range" as const,
      start: new Date("2026-08-20T12:00:00.000Z"),
      end: new Date("2026-08-21T12:00:00.000Z"),
    };

    expect(buildSpeakerIdentityPreflightRequest("sky-id", scope)).toEqual({
      action: "identity-preflight",
      profileId: "sky-id",
      scope,
    });
  });

  it("shortens technical identifiers for advanced diagnostics", () => {
    expect(shortTechnicalId("diarization-run-1234567890")).toBe(
      "diarizat…7890",
    );
    expect(shortTechnicalId("legacy-v0")).toBe("legacy-v0");
  });

  it("keeps a counting source distinct from an empty ready source", () => {
    const preflight = {
      canStart: false,
      status: "counting",
      blockers: [],
      snapshotCutoff: "2026-08-24T12:00:00.000Z",
      preflightToken: null,
      totals: {
        eligibleSegments: 0,
        alreadyCurrent: 0,
        incompatibleSegments: 0,
        estimatedBatches: 0,
      },
      partitions: [],
      sourceIndex: {
        status: "counting",
        buildId: null,
        revision: 0,
        membershipRevision: 1,
        dirtyEpoch: 1,
        builtAt: null,
        sourceSegments: 0,
        scannedSegments: 40_000,
        batchCount: 4,
        currentJobId: "source-index-job",
        recoveryWaiting: false,
        lastProgressAt: "2026-08-24T11:59:00.000Z",
        error: null,
      },
    } satisfies SpeakerIdentityPreflight;

    expect(speakerIdentityPreflightState(preflight)).toEqual({
      sourcePreparing: true,
      noCompatibleSegments: false,
    });
    expect(speakerIdentityPreflightState({
      ...preflight,
      status: "ready",
      sourceIndex: { ...preflight.sourceIndex, status: "ready" },
    })).toEqual({
      sourcePreparing: false,
      noCompatibleSegments: true,
    });
  });
});
