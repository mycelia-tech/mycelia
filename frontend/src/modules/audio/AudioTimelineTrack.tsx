import { AudioWaveform } from "lucide-react";
import type { LayerComponentProps } from "@/core/core.ts";
import { useAudioPlayer } from "./player.tsx";

function formatAudioTrackTime(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function AudioTimelineTrack({
  scale,
  transform,
  width,
}: LayerComponentProps) {
  const {
    chunks,
    currentDate,
    isCreatingSource,
    isPlaying,
    resetDate,
    setIsPlaying,
  } = useAudioPlayer();

  const playbackX = currentDate === null
    ? null
    : transform.applyX(scale(currentDate));
  const isPlayheadVisible = playbackX !== null &&
    playbackX >= 0 &&
    playbackX <= width;
  const playheadLabelX = playbackX === null
    ? 0
    : Math.max(72, Math.min(playbackX, Math.max(72, width - 72)));
  const isBuffering = isPlaying && (isCreatingSource || chunks.length === 0);
  const status = currentDate === null
    ? "Choose a position"
    : isBuffering
    ? "Buffering"
    : isPlaying
    ? "Playing"
    : "Paused";

  return (
    <div
      className={`relative h-[68px] overflow-hidden rounded-md border transition-colors ${
        isPlaying
          ? "border-primary/60 bg-primary/10"
          : "border-border bg-muted/30"
      }`}
      data-testid="audio-timeline-track"
    >
      <div className="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-2 rounded-md border bg-background/90 px-2 py-1 shadow-sm backdrop-blur-sm">
        <span
          className={`flex h-7 w-7 items-center justify-center rounded-full ${
            isPlaying
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
          }`}
        >
          <AudioWaveform className="h-4 w-4" />
        </span>
        <span className="leading-tight">
          <span className="block text-xs font-semibold text-foreground">
            Audio playback
          </span>
          <span className="block text-[10px] text-muted-foreground">
            {status}
          </span>
        </span>
      </div>

      <div className="pointer-events-none absolute right-2 top-2 z-10 hidden rounded bg-background/75 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-sm sm:block">
        Click to play · Right-click to clear
      </div>

      <svg
        className="zoomable h-full w-full cursor-crosshair text-primary"
        width={width}
        height={68}
        aria-label="Audio playback track. Click to play from a position."
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const newScale = transform.rescaleX(scale);
          resetDate(newScale.invert(x));
          setIsPlaying(true);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setIsPlaying(false);
          resetDate(null);
        }}
      >
        <defs>
          <pattern
            id="audio-waveform-pattern"
            width="24"
            height="40"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M2 20v-5m4 10V10m4 19V6m4 16v-4m4 8V12m4 11v-6"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.22"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </pattern>
        </defs>
        <rect
          x="0"
          y="24"
          width={width}
          height="40"
          fill="url(#audio-waveform-pattern)"
        />
        <line
          x1="0"
          y1="44"
          x2={width}
          y2="44"
          stroke="currentColor"
          strokeOpacity="0.18"
        />
        {isPlayheadVisible && playbackX !== null && (
          <g data-testid="audio-playhead">
            <line
              x1={playbackX}
              y1="0"
              x2={playbackX}
              y2="68"
              stroke="currentColor"
              strokeWidth="3"
            />
            <circle
              cx={playbackX}
              cy="44"
              r="6"
              fill="currentColor"
              stroke="var(--background)"
              strokeWidth="3"
            />
          </g>
        )}
      </svg>

      {isPlayheadVisible && currentDate !== null && (
        <div
          className="pointer-events-none absolute bottom-1 z-10 -translate-x-1/2 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold tabular-nums text-primary-foreground shadow-sm"
          style={{ left: playheadLabelX }}
          data-testid="audio-playhead-label"
        >
          {isPlaying ? "Playing" : "Paused"} ·{" "}
          {formatAudioTrackTime(currentDate)}
        </div>
      )}
    </div>
  );
}
