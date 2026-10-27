import { expect } from "@std/expect";
import {
  applyManualIdentityProjection,
  assertPurgeAllowed,
  buildActivationUpdates,
  getObservedRunStatus,
  projectAnnotationState,
} from "./run-lifecycle.ts";

Deno.test("active and building diarization runs cannot be purged", () => {
  for (const status of ["active", "building"] as const) {
    expect(() => assertPurgeAllowed({ status })).toThrow();
  }
  expect(() => assertPurgeAllowed({ status: "superseded" })).not.toThrow();
});

Deno.test("manual projection normalizes legacy and multi-profile identity fields", () => {
  expect(applyManualIdentityProjection({
    state: "matched",
    identityState: "ambiguous",
    resolution: "ambiguous",
    profileId: null,
    candidates: [{ profileId: "sky", score: 0.9 }],
  }, {
    state: "matched",
    profileId: "belka",
    source: "manual_projection",
  })).toEqual({
    state: "matched",
    identityState: "identified",
    resolution: "identified",
    profileId: "belka",
    candidates: [{ profileId: "sky", score: 0.9 }],
    source: "manual_projection",
  });

  const rejected = applyManualIdentityProjection({
    state: "matched",
    identityState: "identified",
    profileId: "sky",
  }, {
    state: "rejected",
    profileId: null,
    source: "manual_projection",
  });
  expect(rejected.identityState).toBe("unknown");
  expect(rejected.resolution).toBe("unknown");
  expect(rejected.profileId).toBeNull();
});

Deno.test("stale building generation without a live campaign is interrupted", () => {
  const now = new Date("2026-08-10T10:00:00Z");
  expect(getObservedRunStatus(
    {
      status: "building",
      createdAt: new Date("2026-08-10T08:00:00Z"),
    },
    [],
    now,
  )).toBe("interrupted");
});

Deno.test("building generation remains building while its campaign is live", () => {
  const now = new Date("2026-08-10T10:00:00Z");
  expect(getObservedRunStatus(
    {
      runId: "run-6",
      status: "building",
      createdAt: new Date("2026-08-10T08:00:00Z"),
    },
    [{ runId: "run-6", status: "running" }],
    now,
  )).toBe("building");
});

Deno.test("activation always activates the new run before superseding the old one", () => {
  const updates = buildActivationUpdates("new-run", "old-run");
  expect(updates[0]).toEqual({ runId: "new-run", status: "active" });
  expect(updates[1]).toEqual({ runId: "old-run", status: "superseded" });
});

Deno.test("manual annotation projects by overlap and wins over automatic identity", () => {
  expect(projectAnnotationState({
    segmentStart: new Date("2026-08-01T10:00:00Z"),
    segmentEnd: new Date("2026-08-01T10:00:10Z"),
    annotationStart: new Date("2026-08-01T10:00:02Z"),
    annotationEnd: new Date("2026-08-01T10:00:09Z"),
    profileId: "sky",
    excludedProfileIds: [],
  })).toEqual({
    state: "matched",
    profileId: "sky",
    source: "manual_projection",
  });

  expect(projectAnnotationState({
    segmentStart: new Date("2026-08-01T10:00:00Z"),
    segmentEnd: new Date("2026-08-01T10:00:10Z"),
    annotationStart: new Date("2026-08-01T10:00:02Z"),
    annotationEnd: new Date("2026-08-01T10:00:09Z"),
    excludedProfileIds: ["sky"],
  })).toEqual({
    state: "rejected",
    profileId: null,
    source: "manual_projection",
  });
});
