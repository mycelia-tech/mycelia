import type { EmptyActivationRepairPreview } from "./activationRepair";

export type SpeakerIdentityScope =
  | { mode: "all_compatible" }
  | { mode: "range"; start: Date; end: Date };

export type SpeakerIdentityPreflightPartition = {
  runId: string;
  embeddingSpaceId: string;
  start: Date | string;
  end: Date | string;
  eligibleSegments: number;
  generation?: number | null;
};

export type SpeakerIdentitySourceIndex = {
  status: "counting" | "ready" | "blocked";
  buildId: string | null;
  revision: number;
  membershipRevision: number;
  dirtyEpoch: number;
  builtAt: Date | string | null;
  sourceSegments: number;
  scannedSegments: number;
  batchCount: number;
  currentJobId: string | null;
  error: string | null;
};

export type SpeakerIdentityPreflight = {
  canStart: boolean;
  status: "counting" | "ready" | "blocked";
  blockers: string[];
  snapshotCutoff: Date | string;
  preflightToken: string | null;
  totals: {
    eligibleSegments: number;
    alreadyCurrent: number;
    incompatibleSegments: number;
    estimatedBatches: number;
  };
  partitions: SpeakerIdentityPreflightPartition[];
  resolved?: {
    profileId: string;
    profileName?: string | null;
    profileRevision: number;
    embeddingSpaceId?: string | null;
    calibrationId?: string | null;
    classificationPolicy?: "full" | "pilot" | null;
    targetPrecision?: number | null;
    maxRangeHours?: number | null;
  };
  coverageRepair?: EmptyActivationRepairPreview | null;
  sourceIndex: SpeakerIdentitySourceIndex;
  sourceSnapshot?: {
    buildId: string;
    revision: number;
    membershipRevision: number;
    builtAt: Date | string;
    maxSegmentId: string | null;
  } | null;
};

export function speakerIdentityPreflightState(
  preflight?: SpeakerIdentityPreflight | null,
) {
  const sourcePreparing = preflight?.status === "counting";
  return {
    sourcePreparing,
    noCompatibleSegments: Boolean(
      preflight && !sourcePreparing && preflight.status === "ready" &&
        preflight.totals.eligibleSegments === 0,
    ),
  };
}

export type SpeakerIdentityCampaignStart = {
  campaignId: string;
  jobId?: string | null;
  status: string;
};

export function buildSpeakerIdentityPreflightRequest(
  profileId: string,
  scope: SpeakerIdentityScope,
) {
  return {
    action: "identity-preflight" as const,
    profileId,
    scope,
  };
}

export function buildSpeakerIdentityCampaignRequest(
  profileId: string,
  preflightToken: string,
) {
  return {
    action: "start-identity-campaign" as const,
    profileId,
    preflightToken,
  };
}

export function shortTechnicalId(value?: string | null): string {
  if (!value) return "—";
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}
