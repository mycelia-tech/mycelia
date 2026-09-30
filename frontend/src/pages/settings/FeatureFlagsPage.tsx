import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { callResource } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Loader2, UserRound } from "lucide-react";
import { toast } from "sonner";

interface ServerConfig {
  features: {
    enable_speaker_identification?: boolean;
  };
}

const FeatureFlagsPage = () => {
  const queryClient = useQueryClient();

  // Fetch current config
  const { data: config, isLoading } = useQuery({
    queryKey: ["server_config"],
    queryFn: async () => {
      return await callResource("config", { action: "get" }) as ServerConfig;
    },
    staleTime: 30 * 1000, // Cache for 30 seconds
  });

  // Update config mutation using action: "patch"
  const updateMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: boolean }) => {
      await callResource("config", {
        action: "patch",
        path: "features",
        updates: { [key]: value },
      });
    },
    onSuccess: () => {
      toast.success("Feature flag updated");
      queryClient.invalidateQueries({ queryKey: ["server_config"] });
    },
    onError: (error: Error) => {
      toast.error("Failed to update", { description: error.message });
    },
  });

  const handleToggle = (key: keyof ServerConfig["features"], value: boolean) => {
    updateMutation.mutate({ key, value });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-2">Feature Flags</h2>
        <p className="text-muted-foreground">
          Enable or disable experimental features.
        </p>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <UserRound className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-base">Speaker Identification</CardTitle>
                  <CardDescription>
                    Recognize enrolled voices in diarization results
                  </CardDescription>
                </div>
              </div>
              <Switch
                checked={config?.features?.enable_speaker_identification ?? false}
                onCheckedChange={(checked) => handleToggle("enable_speaker_identification", checked)}
                disabled={updateMutation.isPending}
              />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-sm text-muted-foreground">
              When enabled, the diarization process will match audio segments against enrolled speaker profiles 
              and automatically label them in transcripts. Enroll voices in Settings → Voice Profiles.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default FeatureFlagsPage;
