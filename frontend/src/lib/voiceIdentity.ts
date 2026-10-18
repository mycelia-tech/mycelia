import { callResource } from "@/lib/api";

export type VoiceProfile = {
  _id: unknown;
  name: string;
  is_primary?: boolean;
  color?: string;
  revision?: number;
  embeddingSpaceId?: string;
  sample_count?: number;
  total_duration?: number;
  enrollmentStatus?: string;
  lifecycleStatus?: string;
  status?: string;
  archivedAt?: Date | string;
};

export type UsableVoiceCalibration = {
  calibrationId: string;
  status: "validated";
  profileId: string;
  profileRevision: number;
  embeddingSpaceId: string;
  targetPrecision: number;
  classificationPolicy?: "full" | "pilot";
  maxRangeHours?: number | null;
  operatorAcceptedLowerPrecision?: boolean;
  validationMetrics?: {
    positivePrecision?: number;
    positiveRecall?: number;
    identified?: number;
    total?: number;
  };
  updatedAt?: Date;
};

export type VoiceIdentityStatus = {
  profile: {
    id: string;
    name: string;
    isPrimary: boolean;
    revision: number;
    embeddingSpaceId: string | null;
    sampleCount: number;
  } | null;
  labels: {
    sky: number;
    notSky: number;
    total: number;
    recordings: number;
    byRecording?: Array<
      { id: string; sky: number; notSky: number; total: number }
    >;
  };
  calibrations: Array<{
    calibrationId: string;
    status: string;
    profileId?: string;
    profileRevision?: number;
    embeddingSpaceId?: string;
    validity?: "usable" | "stale";
    staleReasons?: string[];
    updatedAt?: Date;
  }>;
  usableCalibration: UsableVoiceCalibration | null;
  canClassify: boolean;
  canRunFullClassification?: boolean;
  blockers: string[];
  latestJob?: {
    _id: unknown;
    state: string;
    progress?: Record<string, number>;
    result?: Record<string, number>;
    failedReason?: string;
  } | null;
  latestCampaign?: {
    campaignId: string;
    status: string;
    processedSegments?: number;
    totalSegments?: number | null;
    pendingSegments?: number | null;
    matched?: number;
    rejected?: number;
    identified?: number;
    ambiguous?: number;
    unknown?: number;
    uncertain?: number;
    incompatibleSkipped?: number;
    etaSeconds?: number | null;
    segmentsPerSecond?: number | null;
    batchNumber?: number;
    estimatedBatches?: number;
    currentJobId?: string;
    range?: { start?: Date | string; end?: Date | string };
  } | null;
};

export const voiceIdentityKeys = {
  profiles: ["speaker-profiles"] as const,
  status: (profileId: string | null | undefined) =>
    ["speaker-identity-status", profileId] as const,
};

export function loadVoiceProfiles(): Promise<VoiceProfile[]> {
  return callResource("mongo", {
    action: "find",
    collection: "speaker_profiles",
    query: {},
    options: { sort: { is_primary: -1, created_at: 1 } },
  }) as Promise<VoiceProfile[]>;
}

export function loadVoiceIdentityStatus(
  profileId: string,
): Promise<VoiceIdentityStatus> {
  return callResource("speaker-segments", {
    action: "identity-status",
    profileId,
  }) as Promise<VoiceIdentityStatus>;
}
