import { expect } from "@std/expect";
import {
  buildNextModelSetProfiles,
  identityModelSetActivationBlockers,
  identityModelSetFingerprint,
  type IdentityProfileSnapshot,
  modelSetCanActivate,
  resolveIdentityProjection,
  type SpeakerIdentityEvaluation,
} from "./identity-model-set.ts";

const sky: IdentityProfileSnapshot = {
  profileId: "sky",
  profileRevision: 6,
  calibrationId: "sky-calibration",
  embeddingSpaceId: "voice-space",
};
const belka: IdentityProfileSnapshot = {
  profileId: "belka",
  profileRevision: 2,
  calibrationId: "belka-calibration",
  embeddingSpaceId: "voice-space",
};

function evaluation(
  snapshot: IdentityProfileSnapshot,
  state: SpeakerIdentityEvaluation["state"],
  score: number,
): SpeakerIdentityEvaluation {
  return {
    ...snapshot,
    state,
    score,
    positiveThreshold: 0.7,
    negativeThreshold: 0.35,
  };
}

Deno.test("one matched profile resolves to identified", () => {
  const result = resolveIdentityProjection({
    profileSnapshots: [sky, belka],
    evaluations: [
      evaluation(sky, "matched", 0.9),
      evaluation(belka, "rejected", 0.2),
    ],
  });
  expect(result.resolution).toBe("identified");
  expect(result.profileId).toBe("sky");
  expect(result.complete).toBe(true);
});

Deno.test("multiple matched profiles resolve to ambiguous without a winner", () => {
  const result = resolveIdentityProjection({
    profileSnapshots: [sky, belka],
    evaluations: [
      evaluation(sky, "matched", 0.91),
      evaluation(belka, "matched", 0.86),
    ],
  });
  expect(result.resolution).toBe("ambiguous");
  expect(result.profileId).toBeNull();
  expect(result.candidates.map((candidate) => candidate.profileId)).toEqual([
    "sky",
    "belka",
  ]);
});

Deno.test("a partial model set stays unclassified", () => {
  const result = resolveIdentityProjection({
    profileSnapshots: [sky, belka],
    evaluations: [evaluation(sky, "matched", 0.93)],
  });
  expect(result.resolution).toBe("unclassified");
  expect(result.profileId).toBeNull();
  expect(result.evaluatedProfiles).toBe(1);
  expect(result.expectedProfiles).toBe(2);
});

Deno.test("manual assignment overrides ambiguity and retains candidates", () => {
  const result = resolveIdentityProjection({
    profileSnapshots: [sky, belka],
    evaluations: [
      evaluation(sky, "matched", 0.91),
      evaluation(belka, "matched", 0.86),
    ],
    manual: { profileId: "belka", disposition: "speaker" },
  });
  expect(result.resolution).toBe("identified");
  expect(result.profileId).toBe("belka");
  expect(result.source).toBe("manual_projection");
  expect(result.candidates).toHaveLength(2);
});

Deno.test("stale evaluations do not complete the current model set", () => {
  const staleSky = { ...sky, profileRevision: 5 };
  const result = resolveIdentityProjection({
    profileSnapshots: [sky],
    evaluations: [evaluation(staleSky, "matched", 0.95)],
  });
  expect(result.resolution).toBe("unclassified");
  expect(result.evaluatedProfiles).toBe(0);
});

Deno.test("rebuilding one profile preserves every other frozen snapshot", () => {
  const rebuiltSky = {
    ...sky,
    profileRevision: 7,
    calibrationId: "sky-calibration-7",
  };
  const next = buildNextModelSetProfiles([sky, belka], rebuiltSky);
  expect(next).toEqual([belka, rebuiltSky]);
});

Deno.test("a model set is invisible until ready with complete coverage", () => {
  expect(modelSetCanActivate("building", {
    totalSegments: 10,
    projectedSegments: 10,
  })).toBe(false);
  expect(modelSetCanActivate("ready", {
    totalSegments: 10,
    projectedSegments: 9,
  })).toBe(false);
  expect(modelSetCanActivate("ready", {
    totalSegments: 10,
    projectedSegments: 10,
  })).toBe(true);
});

Deno.test("activation requires a ready full-history model set with exact coverage", () => {
  expect(identityModelSetActivationBlockers({
    status: "ready",
    scope: { mode: "all_compatible" },
    coverage: { totalSegments: 10, projectedSegments: 10 },
  })).toEqual([]);
  expect(identityModelSetActivationBlockers({
    status: "building",
    scope: { mode: "range" },
    coverage: { totalSegments: 10, projectedSegments: 9 },
  })).toEqual([
    "model_set_not_ready",
    "model_set_not_full_history",
    "model_set_coverage_incomplete",
  ]);
});

Deno.test("model set fingerprint is profile-order independent and pins source membership", async () => {
  const input = {
    profiles: [sky, belka],
    sourceSnapshot: {
      buildId: "source-build-7",
      revision: 7,
      membershipRevision: 2,
      maxSegmentId: "68a000000000000000000001",
    },
    partitions: [{
      runId: "legacy-v0",
      embeddingSpaceId: "voice-space",
      sourceSegments: 10,
      maxSegmentId: "68a000000000000000000001",
      start: new Date("2026-08-01T00:00:00Z"),
      end: new Date("2026-08-02T00:00:00Z"),
    }],
    scope: { mode: "all_compatible" as const },
    snapshotCutoff: new Date("2026-08-02T00:00:00Z"),
  };
  const first = await identityModelSetFingerprint(input);
  const reordered = await identityModelSetFingerprint({
    ...input,
    profiles: [belka, sky],
  });
  const replacedMembership = await identityModelSetFingerprint({
    ...input,
    sourceSnapshot: { ...input.sourceSnapshot, membershipRevision: 3 },
  });
  expect(first).toBe(reordered);
  expect(first).not.toBe(replacedMembership);
});
