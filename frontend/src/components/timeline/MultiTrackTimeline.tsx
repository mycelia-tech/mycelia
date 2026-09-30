import React, { memo, useMemo } from "react";
import { useTimelineRange } from "@/stores/timelineRange";
import { useHistogramItems } from "@/modules/histogram/useHistogramItems";
import { useTrackVisibilityStore } from "@/stores/trackVisibilityStore";
import { TimeLayer } from "@/modules/time";
import { ObjectsLayer } from "@/modules/objects";
import { ProcessingLayer } from "@/modules/histogram/ProcessingLayer";
import { AudioLayer } from "@/modules/audio/index";
import {
  AUDIO_CHUNKS_CONFIG,
  AudioChunksTrack,
  DATA_PRESENCE_CONFIG,
  DataPresenceTrack,
  DIARIZATION_COVERAGE_CONFIG,
  DiarizationCoverageTrack,
  DIARIZATIONS_CONFIG,
  DiarizationsTrack,
  TRANSCRIPTIONS_CONFIG,
  TranscriptionsTrack,
  VOICE_DETECTION_CONFIG,
  VoiceDetectionTrack,
} from "./tracks";
import { PHOTOS_CONFIG, PhotosTrack } from "./tracks/PhotosTrack";
import type { PhotoTimelineFocus } from "@/lib/photoTimelineDeepLink";
import { TrackHeader } from "./tracks/TrackHeader";
import { LOCATIONS_CONFIG, LocationTrack } from "./tracks/LocationTrack";
import type { TrackId } from "@/types/tracks";
import type { useTimeline } from "@/hooks/useTimeline";
import { TimeZoneContextTrack } from "./TimeZoneContextTrack";
import { DiarizationLegend } from "./DiarizationLegend";

// Pre-create layer instances (these are stable references)
const TIME_LAYER = TimeLayer();
const PROCESSING_LAYER = ProcessingLayer();
const OBJECTS_LAYER = ObjectsLayer();
const AUDIO_LAYER = AudioLayer();

interface MultiTrackTimelineProps {
  timeline: ReturnType<typeof useTimeline>;
  className?: string;
  focusedPhoto?: PhotoTimelineFocus;
  onFocusedPhotoDismiss?: () => void;
}

// Map track IDs to components
const TRACK_COMPONENTS: Record<TrackId, React.ComponentType<any>> = {
  "voice-detection": VoiceDetectionTrack,
  "data-presence": DataPresenceTrack,
  "transcriptions": TranscriptionsTrack,
  "audio-chunks": AudioChunksTrack,
  "diarization-coverage": DiarizationCoverageTrack,
  "diarizations": DiarizationsTrack,
  "objects": () => null, // Handled separately
  "locations": () => null, // Handled separately
  "photos": PhotosTrack,
};

const TRACK_CONFIGS: Record<TrackId, { label: string; color: string }> = {
  "voice-detection": VOICE_DETECTION_CONFIG,
  "data-presence": DATA_PRESENCE_CONFIG,
  "transcriptions": TRANSCRIPTIONS_CONFIG,
  "audio-chunks": AUDIO_CHUNKS_CONFIG,
  "diarization-coverage": DIARIZATION_COVERAGE_CONFIG,
  "diarizations": DIARIZATIONS_CONFIG,
  "objects": { label: "Objects", color: "#6b7280" },
  "locations": LOCATIONS_CONFIG,
  "photos": PHOTOS_CONFIG,
};

// Stable list of histogram track IDs
const HISTOGRAM_TRACK_IDS: TrackId[] = [
  "voice-detection",
  "data-presence",
  "transcriptions",
  "audio-chunks",
  "diarization-coverage",
  "diarizations",
  "photos",
];

export const MultiTrackTimeline = memo(function MultiTrackTimeline({
  timeline,
  className,
  focusedPhoto,
  onFocusedPhotoDismiss,
}: MultiTrackTimelineProps) {
  const { containerRef, width, timeScale, transform } = timeline;

  const { start, end } = useTimelineRange();
  const { items } = useHistogramItems(start, end);
  const { visibleTracks, trackHeights } = useTrackVisibilityStore();

  // Use pre-created layer components
  const TimeLayerComponent = TIME_LAYER.component;
  const ProcessingLayerComponent = PROCESSING_LAYER.component;
  const ObjectsLayerComponent = OBJECTS_LAYER.component;
  const AudioLayerComponent = AUDIO_LAYER.component;

  const visibleHistogramTracks = useMemo(
    () => HISTOGRAM_TRACK_IDS.filter((id) => visibleTracks.includes(id)),
    [visibleTracks],
  );

  const showObjects = visibleTracks.includes("objects");
  const showDiarizationCoverage = visibleTracks.includes(
    "diarization-coverage",
  );
  const showSpeakerIdentity = visibleTracks.includes("diarizations");
  // Opt-in and fully lazy: when hidden, LocationTrack is not mounted and
  // performs no location API requests at all.
  const showLocations = visibleTracks.includes("locations");

  return (
    <div ref={containerRef} className={`relative ${className || ""}`}>
      <div className="flex flex-col gap-0.5">
        {/* Processing overlay layer */}
        <ProcessingLayerComponent
          scale={timeScale}
          transform={transform}
          width={width}
        />

        {/* Time axis layer (always visible) */}
        <TimeLayerComponent
          scale={timeScale}
          transform={transform}
          width={width}
        />

        <TimeZoneContextTrack
          scale={timeScale}
          transform={transform}
          width={width}
        />

        <DiarizationLegend
          showCoverage={showDiarizationCoverage}
          showIdentity={showSpeakerIdentity}
        />

        {/* Locations track (opt-in, self-fetching) */}
        {showLocations && (
          <div className="relative border-b border-border/30">
            <TrackHeader config={LOCATIONS_CONFIG} />
            <LocationTrack
              scale={timeScale}
              transform={transform}
              width={width}
              height={trackHeights["locations"] ?? 28}
            />
          </div>
        )}

        {/* Data tracks */}
        {visibleHistogramTracks.map((trackId) => {
          const TrackComponent = TRACK_COMPONENTS[trackId];
          const config = TRACK_CONFIGS[trackId];
          const height = trackHeights[trackId] ?? 40;

          if (!TrackComponent) return null;

          return (
            <div
              key={trackId}
              className="relative border-b border-border/30 last:border-b-0"
            >
              <TrackHeader
                config={{
                  ...config,
                  id: trackId,
                  defaultVisible: true,
                  defaultHeight: height,
                }}
              />
              <TrackComponent
                scale={timeScale}
                transform={transform}
                width={width}
                height={height}
                items={items}
                {...(trackId === "photos"
                  ? { focusedPhoto, onFocusedPhotoDismiss }
                  : {})}
              />
            </div>
          );
        })}

        {/* Objects layer */}
        {showObjects && (
          <div className="relative border-b border-border/30">
            <TrackHeader
              config={{
                id: "objects",
                label: "Objects",
                defaultVisible: true,
                defaultHeight: 120,
                color: "#6b7280",
              }}
            />
            <ObjectsLayerComponent
              scale={timeScale}
              transform={transform}
              width={width}
            />
          </div>
        )}

        {/* Audio layer (always visible at bottom) */}
        <AudioLayerComponent
          scale={timeScale}
          transform={transform}
          width={width}
        />
      </div>
    </div>
  );
});

export default MultiTrackTimeline;
