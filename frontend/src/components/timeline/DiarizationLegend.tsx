import React, { memo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DIARIZATION_COVERAGE_LEGEND,
  SPEAKER_IDENTITY_VALIDITY_LEGEND,
  speakerIdentityLegend,
  type TimelineLegendItem,
} from "@/lib/timelineDiarization";
import { useSelectedVoiceProfile } from "@/hooks/useSelectedVoiceProfile";
import { VoiceProfileSelect } from "@/components/voice/VoiceProfileContextBar";

interface LegendGroupProps {
  label: string;
  items: TimelineLegendItem[];
}

const LegendGroup = memo(function LegendGroup({
  label,
  items,
}: LegendGroupProps) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2"
      role="group"
      aria-label={label}
    >
      <span className="font-medium text-foreground/75">{label}</span>
      {items.map((item) => (
        <span
          key={item.id}
          className="inline-flex min-w-0 max-w-full items-center gap-1.5"
          title={`${label}: ${item.label}`}
        >
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-sm border"
            style={{
              backgroundColor: item.color,
              backgroundImage: item.pattern === "diagonal"
                ? `repeating-linear-gradient(135deg, transparent 0 3px, ${
                  item.stroke ?? item.color
                } 3px 4px)`
                : undefined,
              opacity: item.opacity,
              borderColor: item.stroke ?? "rgb(0 0 0 / 0.1)",
              borderStyle: item.strokeDasharray ? "dashed" : "solid",
              borderWidth: item.stroke ? 2 : 1,
            }}
          />
          <span className="break-words">{item.label}</span>
        </span>
      ))}
    </div>
  );
});

interface DiarizationLegendProps {
  showCoverage: boolean;
  showIdentity: boolean;
}

export const DiarizationLegend = memo(function DiarizationLegend({
  showCoverage,
  showIdentity,
}: DiarizationLegendProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const voiceSelection = useSelectedVoiceProfile();
  if (!showCoverage && !showIdentity) return null;

  const speakerFilter = searchParams.get("speakerIdentity") ?? "all";
  const statusFilter = searchParams.get("speakerIdentityStatus") ?? "all";
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };
  const filterClass = (selected: boolean) =>
    `max-w-full break-words rounded-md border px-2 py-1 font-medium transition-colors ${
      selected
        ? "border-primary bg-primary/10 text-primary"
        : "border-border bg-background text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div
      aria-label="Diarization color legend"
      className="space-y-3 rounded-md border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground"
    >
      {showCoverage && (
        <LegendGroup
          label="Diarization coverage"
          items={DIARIZATION_COVERAGE_LEGEND}
        />
      )}
      {showIdentity && (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="font-semibold text-foreground/85">
              Speaker identity
            </span>
            <VoiceProfileSelect
              selection={voiceSelection}
              ariaLabel="Timeline voice profile"
              className="h-8 min-w-0 max-w-full rounded-md border bg-background px-2 text-xs sm:max-w-56"
            />
          </div>
          <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
            <LegendGroup
              label="Speaker"
              items={speakerIdentityLegend({
                name: voiceSelection.selectedProfile?.name,
                color: voiceSelection.selectedProfile?.color,
              })}
            />
            <LegendGroup
              label="Result"
              items={SPEAKER_IDENTITY_VALIDITY_LEGEND}
            />
          </div>
          <div className="flex min-w-0 flex-wrap gap-x-6 gap-y-3 border-t border-border/50 pt-3">
            <div
              className="flex min-w-0 flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Filter voices"
            >
              <span className="mr-1 font-medium text-foreground/75">
                Show voices
              </span>
              {([
                "all",
                "selected",
                "candidate",
                "ambiguous",
                "uncertain",
                "unclassified",
              ] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={speakerFilter === value}
                  className={filterClass(speakerFilter === value)}
                  onClick={() => setFilter("speakerIdentity", value)}
                >
                  {value === "all"
                    ? "All voices"
                    : value === "selected"
                    ? voiceSelection.selectedProfile?.name ?? "Selected"
                    : value === "candidate"
                    ? "Includes candidate"
                    : value[0].toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Filter result status"
            >
              <span className="mr-1 font-medium text-foreground/75">
                Result status
              </span>
              {(["all", "verified", "provisional"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={statusFilter === value}
                  className={filterClass(statusFilter === value)}
                  onClick={() => setFilter("speakerIdentityStatus", value)}
                >
                  {value === "all"
                    ? "Any status"
                    : value === "verified"
                    ? "Verified"
                    : "Pilot"}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
});
