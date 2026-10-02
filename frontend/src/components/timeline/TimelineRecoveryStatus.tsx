import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import type { TimelineIntegrityReport } from "@/types/timelineRecovery";

export function TimelineRecoveryStatus() {
  const { data } = useQuery({
    queryKey: ["timeline-integrity-report"],
    queryFn: async () =>
      await api.callResource("jobs", {
        action: "timeline_integrity_report",
      }) as TimelineIntegrityReport,
    staleTime: 30_000,
    refetchInterval: (query) => {
      const report = query.state.data as TimelineIntegrityReport | undefined;
      if (report?.snapshot?.state === "refreshing") return 2_000;
      if (
        report?.status === "updating" ||
        (report?.maintenance?.pendingDays ?? 0) > 0
      ) return 5_000;
      const status = report?.campaign?.status;
      return status === "queued" || status === "running" ||
          status === "recovering"
        ? 10_000
        : 60_000;
    },
  });

  const campaign = data?.campaign;
  const campaignBusy = campaign?.status === "queued" ||
    campaign?.status === "running" || campaign?.status === "recovering";
  const verificationRequired = campaign?.status === "verifying";
  const maintenance = data?.maintenance;
  const maintenancePending = data?.status === "updating" ||
    (maintenance?.pendingDays ?? 0) > 0;
  const needsAttention = data?.status === "needs_attention" ||
    maintenance?.state === "failed";

  // An old audit or repair history alone does not mean the Timeline is incomplete.
  if (
    !needsAttention && !maintenancePending && !campaignBusy &&
    !verificationRequired
  ) {
    return null;
  }

  const warning = needsAttention || verificationRequired;
  const message = verificationRequired
    ? "Timeline recovery needs verification."
    : needsAttention
    ? "Timeline needs attention."
    : "Timeline is updating.";

  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm ${
        warning
          ? "border-amber-500/30 bg-amber-500/5"
          : "border-blue-500/30 bg-blue-500/5"
      }`}
    >
      <span className="flex items-center gap-2">
        {warning
          ? (
            <AlertTriangle
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-amber-500"
            />
          )
          : (
            <Activity
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-blue-500"
            />
          )}
        {message}
      </span>
      <Link
        to="/jobs#timeline-integrity"
        reloadDocument
        className="ml-auto font-medium underline underline-offset-4"
      >
        Open Jobs
      </Link>
    </div>
  );
}
