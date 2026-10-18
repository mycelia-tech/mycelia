export type SpeakerProfileLifecycleStatus = "active" | "archived";

export type SpeakerProfileReferenceCounts = {
  samples: number;
  annotations: number;
  calibrations: number;
  reviewDecisions: number;
  reviewSessions: number;
  identityDecisions: number;
  campaigns: number;
  jobs: number;
  activeCampaigns: number;
  activeJobs: number;
  activeModelSets: number;
};

export type ProfileArchiveBlocker =
  | "already_archived"
  | "replacement_primary_required"
  | "active_campaign"
  | "active_job"
  | "active_model_set";

export type ProfileArchivePreview = {
  profileId: string;
  profileName: string;
  isPrimary: boolean;
  archivable: boolean;
  blockers: ProfileArchiveBlocker[];
  references: SpeakerProfileReferenceCounts;
  retainedReferences: number;
  snapshotFingerprint: string;
  confirmation: string | null;
  preserves: string[];
};

const REFERENCE_KEYS: Array<keyof SpeakerProfileReferenceCounts> = [
  "samples",
  "annotations",
  "calibrations",
  "reviewDecisions",
  "reviewSessions",
  "identityDecisions",
  "campaigns",
  "jobs",
  "activeCampaigns",
  "activeJobs",
  "activeModelSets",
];

function normalizedReferenceCounts(
  counts: Partial<SpeakerProfileReferenceCounts>,
): SpeakerProfileReferenceCounts {
  return Object.fromEntries(
    REFERENCE_KEYS.map((key) => [
      key,
      Math.max(0, Math.trunc(Number(counts[key] ?? 0))),
    ]),
  ) as unknown as SpeakerProfileReferenceCounts;
}

export function buildProfileArchiveSnapshot(input: {
  profile: {
    id: string;
    name: string;
    revision?: number;
    isPrimary?: boolean;
    lifecycleStatus?: SpeakerProfileLifecycleStatus;
  };
  references: Partial<SpeakerProfileReferenceCounts>;
  replacementPrimaryProfileId?: string | null;
}): ProfileArchivePreview {
  const references = normalizedReferenceCounts(input.references);
  const blockers: ProfileArchiveBlocker[] = [];
  if (input.profile.lifecycleStatus === "archived") {
    blockers.push("already_archived");
  }
  if (input.profile.isPrimary && !input.replacementPrimaryProfileId) {
    blockers.push("replacement_primary_required");
  }
  if (references.activeCampaigns > 0) blockers.push("active_campaign");
  if (references.activeJobs > 0) blockers.push("active_job");
  if (references.activeModelSets > 0) blockers.push("active_model_set");

  const retainedReferences = REFERENCE_KEYS
    .filter((key) =>
      !["activeCampaigns", "activeJobs", "activeModelSets"].includes(key)
    )
    .reduce((sum, key) => sum + references[key], 0);
  const snapshotFingerprint = [
    input.profile.id,
    input.profile.revision ?? 0,
    input.profile.lifecycleStatus ?? "active",
    input.profile.isPrimary ? 1 : 0,
    input.replacementPrimaryProfileId ?? "",
    ...REFERENCE_KEYS.map((key) => references[key]),
  ].join(":");
  const archivable = blockers.length === 0;

  return {
    profileId: input.profile.id,
    profileName: input.profile.name,
    isPrimary: Boolean(input.profile.isPrimary),
    archivable,
    blockers,
    references,
    retainedReferences,
    snapshotFingerprint,
    confirmation: archivable
      ? `ARCHIVE ${input.profile.id} ${retainedReferences}`
      : null,
    preserves: [
      "voice samples",
      "manual annotations",
      "calibrations",
      "review history",
      "identity decisions",
      "campaign and job history",
    ],
  };
}

export function assertProfileArchiveSnapshotCurrent(
  expected: Pick<ProfileArchivePreview, "snapshotFingerprint" | "confirmation">,
  current: ProfileArchivePreview,
  confirmation: string,
): void {
  if (!current.archivable || !current.confirmation) {
    throw new Error(
      `Speaker profile cannot be archived: ${current.blockers.join(", ")}`,
    );
  }
  if (
    expected.snapshotFingerprint !== current.snapshotFingerprint ||
    expected.confirmation !== current.confirmation ||
    confirmation !== current.confirmation
  ) {
    throw new Error(
      "Speaker profile references changed after preview; preview archive again",
    );
  }
}

export function buildProfileArchiveUpdate(input: {
  archivedAt: Date;
  archivedBy: string;
  snapshotFingerprint: string;
}) {
  return {
    $set: {
      lifecycleStatus: "archived" as const,
      archivedAt: input.archivedAt,
      archivedBy: input.archivedBy,
      archiveSnapshotFingerprint: input.snapshotFingerprint,
      is_primary: false,
      updated_at: input.archivedAt,
    },
  };
}

export function buildProfileRestoreUpdate(input: {
  restoredAt: Date;
  restoredBy: string;
}) {
  return {
    $set: {
      lifecycleStatus: "active" as const,
      restoredAt: input.restoredAt,
      restoredBy: input.restoredBy,
      // Restoring a profile must never silently replace the current primary.
      is_primary: false,
      updated_at: input.restoredAt,
    },
    $unset: {
      archivedAt: "",
      archivedBy: "",
      archiveSnapshotFingerprint: "",
    },
  };
}
