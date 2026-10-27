import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertCircle, UserRound } from "lucide-react";
import {
  loadVoiceIdentityStatus,
  voiceIdentityKeys,
} from "@/lib/voiceIdentity";
import { useSelectedVoiceProfile } from "@/hooks/useSelectedVoiceProfile";
import { VoiceProfileContextBar } from "@/components/voice/VoiceProfileContextBar";
import { VoiceIdentityModelSetStatus } from "@/components/voice/VoiceIdentityModelSetStatus";
import { withVoiceProfile } from "@/lib/voiceProfileNavigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function VoiceIdentityStatusCard() {
  const voiceSelection = useSelectedVoiceProfile();
  const primary = voiceSelection.selectedProfile;
  const primaryId = voiceSelection.selectedProfileId;
  const statusQuery = useQuery({
    queryKey: voiceIdentityKeys.status(primaryId),
    enabled: Boolean(primaryId),
    queryFn: () => loadVoiceIdentityStatus(primaryId!),
    refetchInterval: (query) => {
      if (document.visibilityState !== "visible") return false;
      const campaign = query.state.data?.latestCampaign?.status;
      return campaign && ["queued", "counting", "running"].includes(campaign)
        ? 10_000
        : false;
    },
  });
  const status = statusQuery.data;
  const calibrationPolicy = status?.usableCalibration
    ? status.usableCalibration.classificationPolicy ??
      (status.usableCalibration.targetPrecision >= 0.98 ? "full" : "pilot")
    : null;

  return (
    <Card data-testid="voice-identity-status">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserRound className="h-5 w-5 text-primary" />
          Voice identity
        </CardTitle>
        <CardDescription>
          Identify {primary?.name ?? "a selected voice"}{" "}
          in already diarized audio. Calibration teaches the matcher which
          scores mean this voice, another voice, or uncertain; it does not rerun
          diarization.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <VoiceProfileContextBar selection={voiceSelection} compact />
        {voiceSelection.isLoading || (primaryId && statusQuery.isLoading)
          ? (
            <p className="text-sm text-muted-foreground">
              Loading identity readiness…
            </p>
          )
          : !primaryId
          ? (
            <p className="text-sm text-amber-600">
              No voice profile is selected.
            </p>
          )
          : (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline">Voice: {primary?.name}</Badge>
              <Badge variant="outline">
                Revision {status?.profile?.revision ?? primary?.revision ?? 1}
              </Badge>
              <Badge
                className={status?.canClassify
                  ? "bg-green-500/10 text-green-600"
                  : "bg-amber-500/10 text-amber-600"}
              >
                {status?.canClassify
                  ? calibrationPolicy === "pilot"
                    ? "24h pilot ready"
                    : "Ready to classify"
                  : "Calibration needed"}
              </Badge>
              {status?.latestCampaign && (
                <Badge variant="secondary">
                  Backfill {status.latestCampaign.status.replaceAll("_", " ")}
                </Badge>
              )}
            </div>
          )}
        {primaryId && statusQuery.isError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            Voice identity readiness could not be loaded. Open calibration to
            inspect the profile and try again.
          </div>
        )}
        {status?.canClassify && calibrationPolicy === "pilot" && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-muted-foreground">
            Provisional calibration at {Math.round(
              (status.usableCalibration?.targetPrecision ?? 0) * 100,
            )}% is ready for a maximum 24-hour pilot. Review its false matches,
            then return to calibration and reach 98% before historical
            classification.
          </div>
        )}
        {primaryId && !statusQuery.isLoading && !statusQuery.isError &&
          !status?.canClassify && (
          <div
            className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3"
            data-testid="voice-identity-calibration-needed"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  Calibrate {primary?.name ?? "the selected voice"}{" "}
                  before classification
                </p>
                <p className="text-xs text-muted-foreground">
                  Review clear {primary?.name ?? "target"}{" "}
                  / not-{primary?.name ??
                    "target"}{" "}
                  examples, use different recordings to fit and check the
                  thresholds, then save the validated calibration. You choose
                  the required precision; the server recalculates the actual
                  thresholds and shows the resulting coverage and false matches.
                </p>
              </div>
            </div>
            {(status?.blockers?.length ?? 0) > 0 && (
              <div className="text-xs">
                <p className="font-medium">Current blockers</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                  {status?.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild size="sm">
                <Link
                  to={withVoiceProfile(
                    "/settings/voice-identity#calibration",
                    primaryId,
                  )}
                >
                  Open calibration setup
                </Link>
              </Button>
              <span className="text-xs text-muted-foreground">
                Next: label → fit → validate → save → classify
              </span>
            </div>
          </div>
        )}
        <VoiceIdentityModelSetStatus profileId={primaryId} />
        <div className="flex flex-wrap gap-4 text-sm font-medium">
          <Link
            className="text-primary hover:underline"
            to={withVoiceProfile("/settings/voice-profiles", primaryId)}
          >
            Profiles & samples →
          </Link>
          <Link
            className="text-primary hover:underline"
            to={withVoiceProfile(
              "/settings/voice-identity#calibration",
              primaryId,
            )}
          >
            Calibration details →
          </Link>
          <Link
            className="text-primary hover:underline"
            to={withVoiceProfile(
              "/settings/voice-identity/operations",
              primaryId,
            )}
          >
            Operations & generations →
          </Link>
          <Link
            className="text-primary hover:underline"
            to={withVoiceProfile("/jobs?type=speakerIdentity", primaryId)}
          >
            Identity jobs →
          </Link>
          <Link
            className="text-primary hover:underline"
            to={withVoiceProfile("/jobs?type=diarization", primaryId)}
          >
            Diarization jobs →
          </Link>
          <Link
            className="text-primary hover:underline"
            to={withVoiceProfile("/settings/diarization", primaryId)}
          >
            Diarization servers →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
