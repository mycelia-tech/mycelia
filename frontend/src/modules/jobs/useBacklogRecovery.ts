import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "sonner";

export function useBacklogRecovery(onRecoveryQueued: () => unknown) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workerType: string) =>
      api.callResource("jobs", {
        action: "enqueue",
        data: {
          type: workerType,
          ...(["conversation_extractor_merged", "summarization"].includes(
              workerType,
            )
            ? { retryNow: true }
            : {}),
        },
        trigger: { type: "manual", reason: "pipeline_health_run_now" },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["job-stats"] });
      void onRecoveryQueued();
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Failed to launch job",
      ),
  });
}
