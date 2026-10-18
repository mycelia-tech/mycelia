import type { JobInfo } from "@/types/jobs";
import { normalizeObjectId } from "@/lib/diarization";

export type JobVoiceProfileContext = {
  profileIds: string[];
  primaryProfileId: string | null;
  label: string;
};

function snapshots(job: JobInfo): any[] {
  const values: unknown[] = Array.isArray(job.data?.profileSnapshots)
    ? job.data.profileSnapshots
    : job.data?.profileSnapshot
    ? [job.data.profileSnapshot]
    : Array.isArray(job.result?.profileSnapshots)
    ? job.result.profileSnapshots
    : [];
  return values.filter((value): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object"
  );
}

/**
 * Resolve voice context from the immutable job payload first. The current URL
 * selection is only a fallback for older jobs that recorded no profile.
 */
export function resolveJobVoiceProfileContext(
  job: JobInfo,
  fallbackProfileId?: string | null,
): JobVoiceProfileContext {
  const profileSnapshots = snapshots(job);
  const ids = [
    ...profileSnapshots.map((snapshot) => snapshot.profileId),
    ...(Array.isArray(job.data?.profileIds) ? job.data.profileIds : []),
    ...(Array.isArray(job.result?.profileIds) ? job.result.profileIds : []),
    job.data?.profileId,
    job.result?.profileId,
  ].map(normalizeObjectId).filter((value): value is string => Boolean(value));
  const profileIds = [...new Set(ids)];
  if (profileIds.length === 0) {
    const fallback = normalizeObjectId(fallbackProfileId);
    if (fallback) profileIds.push(fallback);
  }

  const names = [
    ...new Set(
      profileSnapshots.map((snapshot) => String(snapshot.name ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const scalarName = String(
    job.data?.profileSnapshot?.name ?? job.data?.profileName ??
      job.result?.profileName ?? job.progress?.profileName ?? "",
  ).trim();
  const label = names.length > 0
    ? names.join(", ")
    : scalarName || (profileIds.length > 1
      ? `${profileIds.length} voice profiles`
      : "selected voice");

  return {
    profileIds,
    primaryProfileId: profileIds[0] ?? null,
    label,
  };
}
