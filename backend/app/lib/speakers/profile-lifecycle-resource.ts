import { ObjectId } from "bson";
import {
  buildProfileArchiveSnapshot,
  type ProfileArchivePreview,
} from "./profile-lifecycle.ts";

type MongoOperation = (request: any) => Promise<any>;

async function count(
  mongo: MongoOperation,
  collection: string,
  query: Record<string, unknown>,
): Promise<number> {
  return Number(await mongo({ action: "count", collection, query })) || 0;
}

function profileReferenceQuery(profileId: string, profileObjectId: ObjectId) {
  const ids = [profileId, profileObjectId];
  return {
    $or: [
      { profileId: { $in: ids } },
      { profileIds: { $in: ids } },
      { "profileSnapshots.profileId": { $in: ids } },
      { "profiles.profileId": { $in: ids } },
    ],
  };
}

export async function computeSpeakerProfileArchivePreview(
  mongo: MongoOperation,
  profileId: string,
  replacementPrimaryProfileId?: string | null,
): Promise<ProfileArchivePreview> {
  const profileObjectId = new ObjectId(profileId);
  const profile = await mongo({
    action: "findOne",
    collection: "speaker_profiles",
    query: { _id: profileObjectId },
  }) as any;
  if (!profile) throw new Error("Speaker profile not found");

  if (replacementPrimaryProfileId) {
    const replacement = await mongo({
      action: "findOne",
      collection: "speaker_profiles",
      query: {
        _id: new ObjectId(replacementPrimaryProfileId),
        lifecycleStatus: { $ne: "archived" },
      },
      options: { projection: { _id: 1 } },
    });
    if (!replacement || replacementPrimaryProfileId === profileId) {
      throw new Error("Choose another active profile as the new primary voice");
    }
  }

  const annotationQuery = {
    $or: [
      { profileId: { $in: [profileId, profileObjectId] } },
      { excludedProfileIds: { $in: [profileId, profileObjectId] } },
    ],
  };
  const reviewDecisionQuery = {
    $or: [
      { profileId: { $in: [profileId, profileObjectId] } },
      { excludedProfileIds: { $in: [profileId, profileObjectId] } },
      { targetProfileIds: { $in: [profileId, profileObjectId] } },
    ],
  };
  const referenceQuery = profileReferenceQuery(profileId, profileObjectId);
  const jobReferenceQuery = {
    type: "speakerIdentity",
    $or: [
      { "data.profileId": { $in: [profileId, profileObjectId] } },
      {
        "data.profileSnapshots.profileId": {
          $in: [profileId, profileObjectId],
        },
      },
      { "data.profileIds": { $in: [profileId, profileObjectId] } },
    ],
  };
  const [
    samples,
    annotations,
    calibrations,
    reviewDecisions,
    reviewSessions,
    embeddedIdentityDecisions,
    evaluations,
    projections,
    campaigns,
    jobs,
    activeCampaigns,
    activeJobs,
    activeModelSets,
  ] = await Promise.all([
    count(mongo, "voice_samples.files", {
      "metadata.profile_id": { $in: [profileId, profileObjectId] },
    }),
    count(mongo, "speaker_annotations", annotationQuery),
    count(mongo, "speaker_calibrations", {
      profileId: { $in: [profileId, profileObjectId] },
    }),
    count(mongo, "speaker_review_decisions", reviewDecisionQuery),
    count(mongo, "speaker_review_sessions", {
      targetProfileIds: { $in: [profileId, profileObjectId] },
    }),
    count(mongo, "diarizations", {
      $or: [
        { "speakerIdentity.profileId": profileId },
        { "speakerIdentity.profileId": profileObjectId },
        { "speakerIdentity.evaluatedProfileId": profileId },
        { "speakerIdentity.evaluatedProfileId": profileObjectId },
        { "matched_speaker.profile_id": profileId },
        { "matched_speaker.profile_id": profileObjectId },
      ],
    }),
    count(mongo, "speaker_identity_evaluations", {
      profileId: { $in: [profileId, profileObjectId] },
    }),
    count(mongo, "speaker_identity_projections", referenceQuery),
    count(mongo, "speaker_identity_campaigns", referenceQuery),
    count(mongo, "jobs", jobReferenceQuery),
    count(mongo, "speaker_identity_campaigns", {
      ...referenceQuery,
      status: { $in: ["counting", "queued", "running"] },
    }),
    count(mongo, "jobs", {
      ...jobReferenceQuery,
      state: { $in: ["waiting", "active", "delayed"] },
    }),
    count(mongo, "identity_model_sets", {
      ...referenceQuery,
      status: { $in: ["building", "ready", "active"] },
    }),
  ]);

  return buildProfileArchiveSnapshot({
    profile: {
      id: profileId,
      name: String(profile.name ?? `Voice ${profileId.slice(0, 8)}`),
      revision: Number(profile.revision ?? 1),
      isPrimary: Boolean(profile.is_primary),
      lifecycleStatus: profile.lifecycleStatus,
    },
    references: {
      samples,
      annotations,
      calibrations,
      reviewDecisions,
      reviewSessions,
      identityDecisions: embeddedIdentityDecisions + evaluations + projections,
      campaigns,
      jobs,
      activeCampaigns,
      activeJobs,
      activeModelSets,
    },
    replacementPrimaryProfileId,
  });
}
