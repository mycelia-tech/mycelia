import { expect } from "@std/expect";
import { activateIdentityModelSet } from "./identity-model-set-store.ts";

const frozenProfile = {
  profileId: "sky",
  profileRevision: 3,
  calibrationId: "sky-calibration",
  embeddingSpaceId: "voice-space",
  evidenceSnapshotHash: "evidence-3",
};

function currentProfileRequest(request: Record<string, any>) {
  if (request.collection === "speaker_profiles") {
    return {
      _id: "sky",
      revision: 3,
      embeddingSpaceId: "voice-space",
      lifecycleStatus: "active",
      activeCalibrationIds: { full: "sky-calibration" },
      calibrationEvidenceRevision: 5,
    };
  }
  if (request.collection === "speaker_calibrations") {
    return {
      calibrationId: "sky-calibration",
      profileId: "sky",
      profileRevision: 3,
      embeddingSpaceId: "voice-space",
      evidenceSnapshotHash: "evidence-3",
      evidenceRevision: 5,
      status: "validated",
      lifecycleStatus: "active",
    };
  }
  return undefined;
}

Deno.test("model-set activation switches the head before superseding the old active set", async () => {
  const operations: Array<{ collection: string; query: any; update: any }> = [];
  const next = {
    _id: "next-id",
    modelSetId: "next",
    embeddingSpaceId: "voice-space",
    profileIds: ["sky"],
    profiles: [frozenProfile],
    status: "ready",
    scope: { mode: "all_compatible" },
    coverage: { totalSegments: 10, projectedSegments: 10 },
    sourceSnapshot: { membershipRevision: 4 },
  };
  const mongo = async (request: Record<string, any>) => {
    const currentProfile = currentProfileRequest(request);
    if (currentProfile) return currentProfile;
    if (
      request.action === "findOne" &&
      request.collection === "identity_model_sets"
    ) {
      return next;
    }
    if (request.collection === "speaker_identity_source_index") {
      return { status: "ready", membershipRevision: 4 };
    }
    if (
      request.action === "findOne" &&
      request.collection === "identity_model_set_heads"
    ) {
      return { embeddingSpaceId: "voice-space", activeModelSetId: "old" };
    }
    if (request.action === "updateOne") {
      operations.push({
        collection: request.collection,
        query: request.query,
        update: request.update,
      });
      return { matchedCount: 1, modifiedCount: 1 };
    }
    throw new Error(`Unexpected request ${JSON.stringify(request)}`);
  };

  await activateIdentityModelSet(mongo, "next", "operator");
  expect(operations.map((operation) => operation.collection)).toEqual([
    "identity_model_sets",
    "identity_model_set_heads",
    "identity_model_sets",
  ]);
  expect(operations[1].update.$set.activeModelSetId).toBe("next");
  expect(operations[2].query).toEqual({
    modelSetId: "old",
    status: "active",
  });
});

Deno.test("model-set activation rejects incomplete coverage without moving the head", async () => {
  let writes = 0;
  const mongo = async (request: Record<string, any>) => {
    const currentProfile = currentProfileRequest(request);
    if (currentProfile) return currentProfile;
    if (
      request.action === "findOne" &&
      request.collection === "identity_model_sets"
    ) {
      return {
        _id: "next-id",
        modelSetId: "next",
        embeddingSpaceId: "voice-space",
        profiles: [frozenProfile],
        status: "ready",
        scope: { mode: "all_compatible" },
        coverage: { totalSegments: 10, projectedSegments: 9 },
        sourceSnapshot: { membershipRevision: 4 },
      };
    }
    if (request.collection === "speaker_identity_source_index") {
      return { status: "ready", membershipRevision: 4 };
    }
    if (request.action === "findOne") return null;
    writes += 1;
    return { matchedCount: 1 };
  };

  await expect(activateIdentityModelSet(mongo, "next")).rejects.toThrow(
    "model_set_coverage_incomplete",
  );
  expect(writes).toBe(0);
});

Deno.test("model-set activation retry finishes superseding after the head already switched", async () => {
  const writes: Array<Record<string, any>> = [];
  const mongo = async (request: Record<string, any>) => {
    const currentProfile = currentProfileRequest(request);
    if (currentProfile) return currentProfile;
    if (
      request.action === "findOne" &&
      request.collection === "identity_model_sets"
    ) {
      return {
        modelSetId: "next",
        embeddingSpaceId: "voice-space",
        profiles: [frozenProfile],
        status: "active",
        scope: { mode: "all_compatible" },
        coverage: { totalSegments: 10, projectedSegments: 10 },
        sourceSnapshot: { membershipRevision: 4 },
      };
    }
    if (request.collection === "speaker_identity_source_index") {
      return { status: "ready", membershipRevision: 4 };
    }
    if (request.action === "findOne") {
      return {
        activeModelSetId: "next",
        previousModelSetId: "old",
      };
    }
    writes.push(request);
    return { matchedCount: 1, modifiedCount: 1 };
  };

  const result = await activateIdentityModelSet(mongo, "next");
  expect(result.reused).toBe(true);
  expect(writes).toHaveLength(1);
  expect(writes[0].query).toEqual({ modelSetId: "old", status: "active" });
});

Deno.test("model-set activation rejects replaced source membership", async () => {
  let writes = 0;
  const mongo = async (request: Record<string, any>) => {
    const currentProfile = currentProfileRequest(request);
    if (currentProfile) return currentProfile;
    if (request.collection === "identity_model_sets") {
      return {
        modelSetId: "next",
        embeddingSpaceId: "voice-space",
        profiles: [frozenProfile],
        status: "ready",
        scope: { mode: "all_compatible" },
        coverage: { totalSegments: 10, projectedSegments: 10 },
        sourceSnapshot: { membershipRevision: 4 },
      };
    }
    if (request.collection === "speaker_identity_source_index") {
      return { status: "ready", membershipRevision: 5 };
    }
    writes += 1;
    return null;
  };

  await expect(activateIdentityModelSet(mongo, "next")).rejects.toThrow(
    "source_membership_changed",
  );
  expect(writes).toBe(0);
});

Deno.test("model-set activation fails a ready set whose frozen profile evidence changed", async () => {
  const writes: Record<string, any>[] = [];
  const mongo = async (request: Record<string, any>) => {
    if (
      request.action === "findOne" &&
      request.collection === "identity_model_sets"
    ) {
      return {
        _id: "next-id",
        modelSetId: "next",
        embeddingSpaceId: "voice-space",
        profileIds: ["sky"],
        profiles: [frozenProfile],
        status: "ready",
        scope: { mode: "all_compatible" },
        coverage: { totalSegments: 10, projectedSegments: 10 },
        sourceSnapshot: { membershipRevision: 4 },
      };
    }
    if (request.collection === "speaker_identity_source_index") {
      return { status: "ready", membershipRevision: 4 };
    }
    if (request.collection === "identity_model_set_heads") return null;
    if (request.collection === "speaker_profiles") {
      return {
        ...(currentProfileRequest(request) as Record<string, any>),
        revision: 4,
      };
    }
    if (request.collection === "speaker_calibrations") {
      return currentProfileRequest(request);
    }
    if (request.action === "updateOne") {
      writes.push(request);
      return { matchedCount: 1, modifiedCount: 1 };
    }
    throw new Error(`Unexpected request ${JSON.stringify(request)}`);
  };

  await expect(activateIdentityModelSet(mongo, "next")).rejects.toThrow(
    "profile_snapshot_changed",
  );
  expect(writes).toHaveLength(1);
  expect(writes[0].collection).toBe("identity_model_sets");
  expect(writes[0].update.$set.status).toBe("failed");
});
