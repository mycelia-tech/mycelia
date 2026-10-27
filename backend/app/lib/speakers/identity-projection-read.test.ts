import { assertEquals } from "jsr:@std/assert@^1.0.15";
import {
  activeModelSetsByEmbeddingSpace,
  activeProjectionIdentity,
  selectedProfileProjectionState,
} from "./identity-projection-read.ts";

Deno.test("projection reads only an active set selected by its embedding-space head", () => {
  const result = activeModelSetsByEmbeddingSpace({
    heads: [{ embeddingSpaceId: "space-a", activeModelSetId: "set-current" }],
    modelSets: [
      {
        modelSetId: "set-old",
        embeddingSpaceId: "space-a",
        profileIds: ["sky"],
        status: "superseded",
      },
      {
        modelSetId: "set-current",
        embeddingSpaceId: "space-a",
        profileIds: ["sky", "belka"],
        status: "active",
      },
    ],
  });

  assertEquals(result.get("space-a"), {
    modelSetId: "set-current",
    embeddingSpaceId: "space-a",
    profileIds: ["sky", "belka"],
    staleProfileIds: [],
  });
});

Deno.test("active set without a segment projection suppresses legacy identity", () => {
  const identity = activeProjectionIdentity({
    modelSet: {
      modelSetId: "set-current",
      embeddingSpaceId: "space-a",
      profileIds: ["sky"],
      staleProfileIds: [],
    },
    selectedProfileId: "sky",
  });

  assertEquals(identity.identityState, "unclassified");
  assertEquals(identity.selectedProfileState, "unclassified");
  assertEquals(identity.modelSetId, "set-current");
});

Deno.test("a stale profile snapshot is unclassified without hiding the active set from other profiles", () => {
  const modelSet = {
    modelSetId: "set-current",
    embeddingSpaceId: "space-a",
    profileIds: ["sky", "belka"],
    staleProfileIds: ["sky"],
  };
  const projection = {
    complete: true,
    resolution: "identified",
    profileId: "sky",
    candidates: [{ profileId: "sky", state: "matched" }],
  };

  const stale = activeProjectionIdentity({
    modelSet,
    projection,
    selectedProfileId: "sky",
  });
  assertEquals(stale.validity, "stale");
  assertEquals(stale.selectedProfileState, "unclassified");

  const unaffected = activeProjectionIdentity({
    modelSet,
    projection,
    selectedProfileId: "belka",
  });
  assertEquals(unaffected.validity, "verified");
  assertEquals(unaffected.selectedProfileState, "unknown");
});

Deno.test("selected profile perspective keeps ambiguity and rejects another winner", () => {
  assertEquals(
    selectedProfileProjectionState({
      resolution: "ambiguous",
      candidates: [
        { profileId: "sky", state: "matched" },
        { profileId: "belka", state: "matched" },
      ],
      selectedProfileId: "sky",
      selectedProfileEvaluated: true,
    }),
    "ambiguous",
  );
  assertEquals(
    selectedProfileProjectionState({
      resolution: "identified",
      profileId: "belka",
      candidates: [{ profileId: "belka", state: "matched" }],
      selectedProfileId: "sky",
      selectedProfileEvaluated: true,
    }),
    "unknown",
  );
});
