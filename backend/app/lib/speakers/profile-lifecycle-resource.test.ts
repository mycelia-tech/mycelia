import { expect } from "@std/expect";
import { ObjectId } from "bson";
import { computeSpeakerProfileArchivePreview } from "./profile-lifecycle-resource.ts";

Deno.test("archive preview counts retained references and blocks in-flight identity work", async () => {
  const profileId = "698349a50dadb6125cb83312";
  const replacementId = "698349a50dadb6125cb83313";
  const counts: Record<string, number> = {
    "voice_samples.files": 5,
    speaker_annotations: 11,
    speaker_calibrations: 2,
    speaker_review_decisions: 13,
    speaker_review_sessions: 3,
    diarizations: 17,
    speaker_identity_evaluations: 19,
    speaker_identity_projections: 23,
    campaigns: 29,
    activeCampaigns: 1,
    jobs: 31,
    activeJobs: 0,
    activeModelSets: 1,
  };
  const mongo = async (request: Record<string, any>) => {
    if (
      request.action === "findOne" && request.collection === "speaker_profiles"
    ) {
      if (String(request.query._id) === replacementId) {
        return { _id: new ObjectId(replacementId) };
      }
      return {
        _id: new ObjectId(profileId),
        name: "Sky",
        revision: 6,
        is_primary: true,
        lifecycleStatus: "active",
      };
    }
    if (request.action !== "count") throw new Error("Unexpected operation");
    if (request.collection === "speaker_identity_campaigns") {
      return request.query.status ? counts.activeCampaigns : counts.campaigns;
    }
    if (request.collection === "jobs") {
      return request.query.state ? counts.activeJobs : counts.jobs;
    }
    if (request.collection === "identity_model_sets") {
      return counts.activeModelSets;
    }
    return counts[request.collection] ?? 0;
  };

  const preview = await computeSpeakerProfileArchivePreview(
    mongo,
    profileId,
    replacementId,
  );

  expect(preview.isPrimary).toBe(true);
  expect(preview.references.identityDecisions).toBe(59);
  expect(preview.references.activeCampaigns).toBe(1);
  expect(preview.references.activeModelSets).toBe(1);
  expect(preview.archivable).toBe(false);
  expect(preview.blockers).toEqual(["active_campaign", "active_model_set"]);
  expect(preview.confirmation).toBeNull();
});
