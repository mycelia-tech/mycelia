import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import Form from "@rjsf/shadcn";
import validator from "@rjsf/validator-ajv8";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { prepareJobLaunchSchema } from "@/lib/jobLaunchDefaults";
import { SpeakerIdentityLaunchPanel } from "@/components/SpeakerIdentityLaunchDialog";

export default function CreateJobPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [selectedType, setSelectedType] = useState<string | null>(null);

  const { data: schemas, isLoading: isLoadingSchemas } = useQuery({
    queryKey: ["job-schemas"],
    queryFn: async () => {
      const response = await api.callResource("jobs", {
        action: "schemas",
      });
      return response as Record<string, any>;
    },
  });
  const needsVoiceProfile = selectedType === "profileReenrollment";
  const { data: pipelineHealth, isLoading: isLoadingHealth } = useQuery<any>({
    queryKey: ["pipeline-health", "job-launch", selectedType],
    enabled: needsVoiceProfile,
    queryFn: () =>
      api.callResource("jobs", {
        action: "services_health",
        force: true,
      }),
  });
  const diarizatorHealth = pipelineHealth?.services?.find((service: any) =>
    service.id === "diarizator"
  );
  const dependencyReady = !needsVoiceProfile ||
    diarizatorHealth?.status === "healthy";
  const dependencyMessage = needsVoiceProfile && !isLoadingHealth &&
      !dependencyReady
    ? diarizatorHealth?.message ??
      "Diarizator is unavailable. Start the CPU or GPU Docker service first."
    : null;
  const {
    data: speakerProfiles = [],
    isLoading: isLoadingProfiles,
    isError: isProfilesError,
  } = useQuery<any[]>({
    queryKey: ["speaker_profiles"],
    enabled: needsVoiceProfile,
    queryFn: () =>
      api.callResource("mongo", {
        action: "find",
        collection: "speaker_profiles",
        query: {},
        options: { sort: { is_primary: -1, name: 1 } },
      }) as Promise<any[]>,
  });

  const launchSchema = useMemo(() => {
    if (!selectedType || !schemas?.[selectedType]?.input) return null;
    const { $schema, ...schema } = schemas[selectedType].input;
    return prepareJobLaunchSchema(schema, selectedType, speakerProfiles);
  }, [schemas, selectedType, speakerProfiles]);

  const enqueueMutation = useMutation({
    mutationFn: async (data: any) => {
      return await api.callResource("jobs", {
        action: "enqueue",
        data: {
          ...data,
          type: selectedType,
        },
        trigger: {
          type: "manual",
          reason: `Manual launch of ${selectedType} via Launch Job page`,
        },
      });
    },
    onSuccess: (response) => {
      toast.success(`Job enqueued successfully! ID: ${response.jobId}`);
      navigate("/jobs");
    },
    onError: (error) => {
      console.error("Failed to enqueue job:", error);
      toast.error("Failed to enqueue job", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  // Pre-select job type from URL query parameter
  useEffect(() => {
    const typeParam = searchParams.get("type");
    if (typeParam && schemas && typeParam in schemas && !selectedType) {
      setSelectedType(typeParam);
    }
  }, [searchParams, schemas, selectedType]);

  const handleTypeChange = (value: string) => {
    setSelectedType(value);
  };

  const onSubmit = (formData: any) => {
    enqueueMutation.mutate(formData);
  };

  const jobTypes = schemas ? Object.keys(schemas) : [];

  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/jobs" aria-label="Back to Jobs">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-3xl font-bold tracking-tight">Launch New Job</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Select Job Type</CardTitle>
        </CardHeader>
        <CardContent>
          <Select
            onValueChange={handleTypeChange}
            value={selectedType || undefined}
          >
            <SelectTrigger aria-label="Job type" className="w-full sm:max-w-md">
              <SelectValue placeholder="Select a job type..." />
            </SelectTrigger>
            <SelectContent>
              {isLoadingSchemas
                ? (
                  <SelectItem value="loading" disabled>
                    Loading schemas...
                  </SelectItem>
                )
                : (
                  jobTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))
                )}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {selectedType && schemas?.[selectedType] && (
        <Card>
          <CardHeader>
            <CardTitle className="capitalize">
              {selectedType} Configuration
            </CardTitle>
          </CardHeader>
          <CardContent>
            {needsVoiceProfile && isLoadingProfiles && (
              <p className="text-sm text-muted-foreground">
                Loading known voice profiles…
              </p>
            )}
            {needsVoiceProfile && isProfilesError && (
              <p className="text-sm text-destructive">
                Could not load voice profiles. Refresh the page and try again.
              </p>
            )}
            {needsVoiceProfile && !isLoadingProfiles && !isProfilesError &&
              speakerProfiles.length === 0 && (
              <p className="text-sm text-destructive">
                No voice profiles exist yet. Create one in Voice Profiles first.
              </p>
            )}
            {needsVoiceProfile && isLoadingHealth && (
              <p className="text-sm text-muted-foreground">
                Checking Diarizator health…
              </p>
            )}
            {dependencyMessage && (
              <p className="text-sm text-destructive">{dependencyMessage}</p>
            )}
            {selectedType === "speakerIdentity"
              ? (
                <SpeakerIdentityLaunchPanel
                  onQueued={(jobId) => navigate(`/jobs/${jobId}`)}
                />
              )
              : (
                <div className="rjsf-container">
                  {launchSchema && (!needsVoiceProfile ||
                    (!isLoadingProfiles && !isProfilesError &&
                      speakerProfiles.length > 0)) &&
                    (
                      <Form
                        schema={launchSchema}
                        validator={validator}
                        uiSchema={selectedType === "profileReenrollment"
                          ? { type: { "ui:widget": "hidden" } }
                          : undefined}
                        onSubmit={(data: any) => onSubmit(data.formData)}
                        disabled={enqueueMutation.isPending || !dependencyReady}
                        noHtml5Validate
                        showErrorList={false}
                        liveValidate={false}
                      >
                        <div className="mt-6">
                          <Button
                            type="submit"
                            disabled={enqueueMutation.isPending ||
                              !dependencyReady}
                            className="w-full sm:w-auto"
                          >
                            {enqueueMutation.isPending
                              ? (
                                "Launching..."
                              )
                              : (
                                <>
                                  <Play className="h-4 w-4 mr-2" />
                                  Launch Job
                                </>
                              )}
                          </Button>
                        </div>
                      </Form>
                    )}
                </div>
              )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
