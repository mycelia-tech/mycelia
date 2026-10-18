import React, { memo, useMemo } from "react";
import type { TrackConfig, TrackRenderProps } from "@/types/tracks";
import type { HistogramItem } from "@/modules/histogram/useHistogramCache";
import { BaseTrack } from "./BaseTrack";
import { useQuery } from "@tanstack/react-query";
import { callResource } from "@/lib/api";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  coverageBucketMs,
  coverageColor,
  dominantCoverageState,
  hasActiveDiarizationCoverage,
} from "@/lib/diarizationCoverage";
import { useTimelineQueryRange } from "@/hooks/useTimelineQueryRange";
import {
  coverageOpacity,
  DIARIZATION_BUILDING_COLOR,
  speakerIdentityAppearance,
} from "@/lib/timelineDiarization";
import {
  buildSpeakerTimelineSummaryRequest,
  dominantSpeakerBucket,
  hasSpeakerTimelineData,
  type SpeakerTimelineFilters,
  type SpeakerTimelineSummary,
} from "@/lib/speakerTimeline";
import { useSelectedVoiceProfile } from "@/hooks/useSelectedVoiceProfile";
import { withVoiceProfile } from "@/lib/voiceProfileNavigation";

const SPEAKER_QUERY_DELAY_MS = 650;

function speakerTimelineDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

// Config for each histogram track type
export const TRANSCRIPTIONS_CONFIG: TrackConfig = {
  id: "transcriptions",
  label: "Transcriptions",
  description: "Transcription density",
  defaultVisible: true,
  defaultHeight: 40,
  color: "hsl(262, 83%, 58%)", // Purple
};

export const AUDIO_CHUNKS_CONFIG: TrackConfig = {
  id: "audio-chunks",
  label: "Audio",
  description: "Audio chunk density",
  defaultVisible: true,
  defaultHeight: 40,
  color: "hsl(199, 89%, 48%)", // Cyan
};

export const DIARIZATIONS_CONFIG: TrackConfig = {
  id: "diarizations",
  label: "Speaker identity",
  description: "Selected / candidate / other / uncertain voice intervals",
  defaultVisible: true,
  defaultHeight: 40,
  color: "hsl(25, 95%, 53%)", // Orange
};

export const DIARIZATION_COVERAGE_CONFIG: TrackConfig = {
  id: "diarization-coverage",
  label: "Diarization coverage",
  description: "Done / processing / pending / errors",
  defaultVisible: true,
  defaultHeight: 32,
  color: "#2563eb",
};

type DataKey = "audio_chunks" | "transcriptions" | "diarizations";

interface HistogramTrackProps extends TrackRenderProps {
  config: TrackConfig;
  dataKey: DataKey;
}

const HistogramTrackInner = memo(function HistogramTrackInner({
  scale,
  transform,
  width,
  height,
  items,
  config,
  dataKey,
}: HistogramTrackProps) {
  const rescaledScale = useMemo(
    () => transform.rescaleX(scale),
    [scale, transform],
  );

  const { bars, maxCount } = useMemo(() => {
    let max = 1;
    const barData = items.map((item) => {
      const count = item.totals[dataKey]?.count ?? 0;
      if (count > max) max = count;
      return {
        id: item.id,
        x: rescaledScale(item.start),
        width: Math.max(rescaledScale(item.end) - rescaledScale(item.start), 1),
        count,
        stale: item.stale,
      };
    });
    return { bars: barData, maxCount: max };
  }, [items, rescaledScale, dataKey]);

  return (
    <BaseTrack
      config={config}
      scale={scale}
      transform={transform}
      width={width}
      height={height}
      items={items}
    >
      <g>
        {bars.map((bar) => {
          const barHeight = maxCount > 0 ? (bar.count / maxCount) * height : 0;
          return (
            <rect
              key={bar.id}
              x={bar.x}
              y={height - barHeight}
              width={bar.width}
              height={barHeight}
              fill={bar.stale ? "rgb(255, 182, 193)" : config.color}
              opacity={0.8}
            />
          );
        })}
      </g>
    </BaseTrack>
  );
});

// Export specialized track components
export const TranscriptionsTrack = memo(function TranscriptionsTrack(
  props: TrackRenderProps,
) {
  return (
    <HistogramTrackInner
      {...props}
      config={TRANSCRIPTIONS_CONFIG}
      dataKey="transcriptions"
    />
  );
});

export const AudioChunksTrack = memo(function AudioChunksTrack(
  props: TrackRenderProps,
) {
  return (
    <HistogramTrackInner
      {...props}
      config={AUDIO_CHUNKS_CONFIG}
      dataKey="audio_chunks"
    />
  );
});

export const DiarizationsTrack = memo(function DiarizationsTrack(
  props: TrackRenderProps,
) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const voiceSelection = useSelectedVoiceProfile();
  const selectedProfileId = voiceSelection.selectedProfileId;
  const rescaledScale = useMemo(() => props.transform.rescaleX(props.scale), [
    props.transform,
    props.scale,
  ]);
  const [start, end] = rescaledScale.domain() as [Date, Date];
  const rangeMs = Math.max(0, end.getTime() - start.getTime());
  const farZoom = rangeMs / Math.max(props.width, 1) > 60_000;
  const queryAlignmentMs = coverageBucketMs(rangeMs, props.width);
  const queryRange = useTimelineQueryRange(
    start,
    end,
    queryAlignmentMs,
    SPEAKER_QUERY_DELAY_MS,
  );
  const queryRangeReady = queryRange.alignmentMs === queryAlignmentMs &&
    queryRange.start.getTime() <= start.getTime() &&
    queryRange.end.getTime() >= end.getTime();
  const requestedSpeakerFilter = searchParams.get("speakerIdentity");
  const speakerFilter = requestedSpeakerFilter === "sky" ? "selected" : [
      "selected",
      "candidate",
      "ambiguous",
      "uncertain",
      "unclassified",
    ].includes(requestedSpeakerFilter ?? "")
    ? requestedSpeakerFilter!
    : "all";
  const statusFilter = searchParams.get("speakerIdentityStatus") ===
      "verified"
    ? "verified"
    : searchParams.get("speakerIdentityStatus") === "provisional"
    ? "provisional"
    : "all";
  const filters = useMemo<SpeakerTimelineFilters>(() => ({
    ...(speakerFilter === "selected"
      ? {
        states: ["identified" as const, "matched" as const],
        inclusion: "selected_only" as const,
      }
      : speakerFilter === "candidate"
      ? { inclusion: "includes_candidate" as const }
      : speakerFilter === "ambiguous"
      ? { states: ["ambiguous" as const] }
      : speakerFilter === "uncertain"
      ? { states: ["uncertain" as const] }
      : speakerFilter === "unclassified"
      ? { states: ["unclassified" as const] }
      : {}),
    ...(statusFilter === "verified"
      ? { validities: ["verified" as const, "manual" as const] }
      : statusFilter === "provisional"
      ? { validities: ["provisional" as const] }
      : {}),
  }), [speakerFilter, statusFilter]);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [
      "speaker-timeline-summary",
      queryRange.start.getTime(),
      queryRange.end.getTime(),
      queryAlignmentMs,
      farZoom ? "buckets" : "intervals",
      selectedProfileId,
      speakerFilter,
      statusFilter,
    ],
    queryFn: () =>
      callResource(
        "speaker-segments",
        buildSpeakerTimelineSummaryRequest({
          start: queryRange.start,
          end: queryRange.end,
          detail: farZoom ? "buckets" : "intervals",
          bucketMs: queryAlignmentMs,
          filters,
          profileId: selectedProfileId,
        }),
      ) as Promise<SpeakerTimelineSummary>,
    staleTime: 60_000,
    retry: 1,
    enabled: queryRangeReady && Boolean(selectedProfileId),
  });
  const marks = useMemo(() => {
    if (data?.mode === "intervals") {
      return (data.intervals ?? []).map((interval) => ({
        id: interval.segmentId,
        x: rescaledScale(speakerTimelineDate(interval.start)),
        width: Math.max(
          2,
          rescaledScale(speakerTimelineDate(interval.end)) -
            rescaledScale(speakerTimelineDate(interval.start)),
        ),
        state: interval.state,
        validity: interval.validity,
        segmentId: interval.segmentId,
        start: speakerTimelineDate(interval.start),
        end: speakerTimelineDate(interval.end),
        count: 1,
      }));
    }
    return (data?.buckets ?? []).map((bucket, index) => {
      const appearance = dominantSpeakerBucket(bucket);
      const bucketStart = speakerTimelineDate(bucket.start);
      const bucketEnd = speakerTimelineDate(bucket.end);
      const x = rescaledScale(bucketStart);
      return {
        id: `bucket-${bucketStart.getTime()}-${index}`,
        x,
        width: Math.max(1, rescaledScale(bucketEnd) - x),
        state: appearance.state,
        validity: appearance.validity,
        segmentId: undefined,
        start: bucketStart,
        end: bucketEnd,
        count: Object.values(bucket.counts).reduce(
          (total, count) => total + (count ?? 0),
          0,
        ),
      };
    });
  }, [data, rescaledScale]);
  const hasData = hasSpeakerTimelineData(data);
  return (
    <BaseTrack {...props} config={DIARIZATIONS_CONFIG}>
      <g>
        <defs>
          <pattern
            id="speaker-identity-ambiguous-pattern"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(135)"
          >
            <rect
              width="6"
              height="6"
              fill={voiceSelection.selectedProfile?.color ?? "#22c55e"}
              opacity="0.35"
            />
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="6"
              stroke={voiceSelection.selectedProfile?.color ?? "#22c55e"}
              strokeWidth="2"
            />
          </pattern>
        </defs>
        {isLoading && !data && (
          <text
            x={8}
            y={Math.max(14, props.height / 2 + 4)}
            fontSize={11}
            fill="currentColor"
            opacity={0.65}
          >
            Loading speaker identity…
          </text>
        )}
        {isError && (
          <text
            x={8}
            y={Math.max(14, props.height / 2 + 4)}
            fontSize={11}
            fill="#dc2626"
            className="cursor-pointer"
            onClick={() => void refetch()}
          >
            Speaker identity unavailable — click to retry
          </text>
        )}
        {!isLoading && !isError && !hasData && (
          <text
            x={8}
            y={Math.max(14, props.height / 2 + 4)}
            fontSize={11}
            fill="currentColor"
            opacity={0.55}
          >
            {!selectedProfileId
              ? "Select a voice profile to show speaker identity"
              : data?.reason ??
                (speakerFilter === "all" && statusFilter === "all"
                  ? "No speaker identity in this range"
                  : "No speaker identity matches these filters")}
          </text>
        )}
        {marks.map((mark) => {
          const appearance = speakerIdentityAppearance(
            mark.state,
            mark.validity,
            {
              name: data?.profile?.name ?? voiceSelection.selectedProfile?.name,
              color: data?.profile?.color ??
                voiceSelection.selectedProfile?.color,
            },
          );
          return (
            <rect
              key={mark.id}
              x={mark.x}
              y={4}
              width={mark.width}
              height={Math.max(4, props.height - 8)}
              fill={appearance.pattern === "diagonal"
                ? "url(#speaker-identity-ambiguous-pattern)"
                : appearance.color}
              opacity={appearance.opacity}
              stroke={appearance.stroke}
              strokeDasharray={appearance.strokeDasharray}
              strokeWidth={appearance.stroke ? 1.5 : undefined}
              className="cursor-pointer"
              onClick={() => {
                if (mark.segmentId) {
                  navigate(withVoiceProfile(
                    `/diarizations/${mark.segmentId}`,
                    selectedProfileId,
                  ));
                  return;
                }
                const next = new URLSearchParams(searchParams);
                next.set("start", String(mark.start.getTime()));
                next.set("end", String(mark.end.getTime()));
                navigate(`/timeline?${next.toString()}`);
              }}
            >
              <title>
                {appearance.label}
                {mark.count > 1 ? ` · ${mark.count} segments` : ""}
              </title>
            </rect>
          );
        })}
      </g>
    </BaseTrack>
  );
});

export const DiarizationCoverageTrack = memo(
  function DiarizationCoverageTrack(props: TrackRenderProps) {
    const navigate = useNavigate();
    const selectedProfileId = useSelectedVoiceProfile().selectedProfileId;
    const rescaledScale = useMemo(
      () => props.transform.rescaleX(props.scale),
      [props.transform, props.scale],
    );
    const [start, end] = rescaledScale.domain() as [Date, Date];
    const bucketMs = coverageBucketMs(
      end.getTime() - start.getTime(),
      props.width,
    );
    const queryRange = useTimelineQueryRange(start, end, bucketMs);
    const queryBucketMs = queryRange.alignmentMs;
    const { data, isLoading, isError, refetch } = useQuery({
      queryKey: [
        "diarization-coverage",
        queryRange.start.getTime(),
        queryRange.end.getTime(),
        queryBucketMs,
      ],
      queryFn: () =>
        callResource("speaker-segments", {
          action: "coverage",
          start: queryRange.start,
          end: queryRange.end,
          bucketMs: queryBucketMs,
        }) as Promise<{
          buckets: Array<{
            start: number;
            end: number;
            counts: Record<string, number>;
          }>;
          buildingRuns: Array<{
            runId: string;
            range: { start: string | Date; end: string | Date };
          }>;
        }>,
      staleTime: 10_000,
      placeholderData: (previousData) => previousData,
      refetchInterval: (query) => {
        const current = query.state.data as
          | {
            buckets?: Array<{ counts?: Record<string, number> }>;
            buildingRuns?: unknown[];
          }
          | undefined;
        return hasActiveDiarizationCoverage(current) ? 15_000 : false;
      },
      retry: 1,
    });
    return (
      <BaseTrack {...props} config={DIARIZATION_COVERAGE_CONFIG}>
        <g>
          {isLoading && (
            <text
              x={8}
              y={Math.max(14, props.height / 2 + 4)}
              fontSize={11}
              fill="currentColor"
              opacity={0.65}
            >
              Loading diarization coverage…
            </text>
          )}
          {isError && (
            <text
              x={8}
              y={Math.max(14, props.height / 2 + 4)}
              fontSize={11}
              fill="#dc2626"
              className="cursor-pointer"
              onClick={() => void refetch()}
            >
              Coverage unavailable — click to retry
            </text>
          )}
          {!isLoading && !isError && (data?.buckets.length ?? 0) === 0 &&
            (data?.buildingRuns.length ?? 0) === 0 && (
            <text
              x={8}
              y={Math.max(14, props.height / 2 + 4)}
              fontSize={11}
              fill="currentColor"
              opacity={0.55}
            >
              No speech chunks in this range
            </text>
          )}
          {(data?.buckets ?? []).map((bucket) => {
            const state = dominantCoverageState(bucket.counts);
            const x = rescaledScale(new Date(bucket.start));
            const width = Math.max(
              1,
              rescaledScale(new Date(bucket.end)) - x,
            );
            return (
              <rect
                key={bucket.start}
                x={x}
                y={5}
                width={width}
                height={Math.max(4, props.height - 10)}
                fill={coverageColor(state)}
                opacity={coverageOpacity(state)}
                className="cursor-pointer"
                onClick={() =>
                  navigate(withVoiceProfile(
                    "/jobs?type=diarization",
                    selectedProfileId,
                  ))}
              >
                <title>
                  {state.replace("_", " ")} ·{" "}
                  {Object.values(bucket.counts).reduce(
                    (sum, count) => sum + count,
                    0,
                  )} speech chunks
                </title>
              </rect>
            );
          })}
          {(data?.buildingRuns ?? []).map((run) => {
            const x = rescaledScale(new Date(run.range.start));
            return (
              <rect
                key={run.runId}
                x={x}
                y={1}
                width={Math.max(2, rescaledScale(new Date(run.range.end)) - x)}
                height={3}
                fill={DIARIZATION_BUILDING_COLOR}
                opacity={0.9}
              >
                <title>Building {run.runId}</title>
              </rect>
            );
          })}
        </g>
      </BaseTrack>
    );
  },
);
