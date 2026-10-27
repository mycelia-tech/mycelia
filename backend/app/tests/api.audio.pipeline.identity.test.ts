import { expect } from "@std/expect";
import { hasSpeakerIdentityBacklog } from "@/routes/api.audio.pipeline.ts";

function modelSetBacklogMongo(sourceSegments: number) {
  const requests: Record<string, any>[] = [];
  const mongo = async (request: Record<string, any>) => {
    requests.push(request);
    if (request.collection === "identity_model_set_heads") {
      return [{
        activeModelSetId: "set-active",
        embeddingSpaceId: "voice-space",
      }];
    }
    if (request.collection === "identity_model_sets") {
      return [{
        modelSetId: "set-active",
        status: "active",
        embeddingSpaceId: "voice-space",
        coverage: { totalSegments: 10, projectedSegments: 10 },
        sourceSnapshot: { membershipRevision: 2 },
      }];
    }
    if (request.collection === "speaker_identity_campaigns") return null;
    if (request.collection === "speaker_identity_source_index") {
      return {
        _id: "active",
        status: "ready",
        publishedBuildId: "source-3",
        membershipRevision: 2,
      };
    }
    if (request.collection === "speaker_identity_source_partitions") {
      return [{
        buildId: "source-3",
        embeddingSpaceId: "voice-space",
        sourceSegments,
        status: "ready",
      }];
    }
    throw new Error(`Unexpected request: ${JSON.stringify(request)}`);
  };
  return { mongo, requests };
}

Deno.test("pipeline identity backlog uses active projection coverage, not legacy embedded fields", async () => {
  const complete = modelSetBacklogMongo(10);

  expect(await hasSpeakerIdentityBacklog(complete.mongo as any)).toBe(false);
  expect(
    complete.requests.some((request) => request.collection === "diarizations"),
  ).toBe(false);

  const appended = modelSetBacklogMongo(12);
  expect(await hasSpeakerIdentityBacklog(appended.mongo as any)).toBe(true);
});
