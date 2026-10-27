import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import { Play, FileText, Link2, Link2Off, Volume2, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { callResource } from "@/lib/api";
import { PlayPauseButton } from "@/modules/audio/PlayPauseButton";
import { useAudioPlayer } from "@/modules/audio/player";
import { useSettingsStore } from "@/stores/settingsStore";
import { formatTime } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

interface ObjectPlayerTranscriptProps {
  timeRange: { start: Date | string; end?: Date | string | null };
  /** Fixed height in pixels (deprecated, use minHeight/maxHeight) */
  height?: number;
  /** Minimum height in pixels */
  minHeight?: number;
  /** Maximum height in pixels */
  maxHeight?: number;
}

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

interface TranscriptionDoc {
  _id: unknown;
  start: Date;
  end: Date;
  segments: TranscriptSegment[];
}

interface RenderSegment {
  time: Date;
  endTime: Date;
  text: string;
}

const SPEED_OPTIONS = [
  { value: 0.5, label: "0.5x" },
  { value: 0.75, label: "0.75x" },
  { value: 1, label: "1x" },
  { value: 1.25, label: "1.25x" },
  { value: 1.5, label: "1.5x" },
  { value: 1.75, label: "1.75x" },
  { value: 2, label: "2x" },
  { value: 2.5, label: "2.5x" },
  { value: 3, label: "3x" },
];

// Waveform visualization component based on transcript segments
interface WaveformDisplayProps {
  segments: RenderSegment[];
  startDate: Date;
  endDate: Date;
  currentDate: Date | null;
  onSeek: (date: Date) => void;
}

function WaveformDisplay({ segments, startDate, endDate, currentDate, onSeek }: WaveformDisplayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const totalDuration = endDate.getTime() - startDate.getTime();

  // Generate waveform bars based on time buckets
  const bars = useMemo(() => {
    const numBars = 100; // Number of bars to display
    const bucketSize = totalDuration / numBars;
    const result: { intensity: number; hasVoice: boolean }[] = [];

    for (let i = 0; i < numBars; i++) {
      const bucketStart = startDate.getTime() + i * bucketSize;
      const bucketEnd = bucketStart + bucketSize;

      // Check if any segment overlaps with this bucket
      let intensity = 0;
      let hasVoice = false;

      for (const seg of segments) {
        const segStart = seg.time.getTime();
        const segEnd = seg.endTime.getTime();

        // Calculate overlap
        const overlapStart = Math.max(bucketStart, segStart);
        const overlapEnd = Math.min(bucketEnd, segEnd);

        if (overlapEnd > overlapStart) {
          hasVoice = true;
          // Calculate how much of the bucket is covered by speech
          const coverage = (overlapEnd - overlapStart) / bucketSize;
          // Add some variation based on text length
          const textIntensity = Math.min(1, (seg.text.length / 100));
          intensity = Math.max(intensity, coverage * (0.3 + textIntensity * 0.7));
        }
      }

      // Add slight noise for silent parts
      if (!hasVoice) {
        intensity = 0.05 + Math.random() * 0.05;
      }

      result.push({ intensity, hasVoice });
    }

    return result;
  }, [segments, startDate, totalDuration]);

  // Calculate playhead position
  const playheadPosition = currentDate
    ? ((currentDate.getTime() - startDate.getTime()) / totalDuration) * 100
    : 0;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const targetTime = new Date(startDate.getTime() + totalDuration * percentage);
    onSeek(targetTime);
  };

  return (
    <div
      ref={containerRef}
      className="relative h-12 bg-background/50 rounded cursor-pointer group"
      onClick={handleClick}
      title="Click to seek"
    >
      {/* Waveform bars */}
      <div className="absolute inset-0 flex items-center justify-between gap-px px-1">
        {bars.map((bar, idx) => (
          <div
            key={idx}
            className={cn(
              "flex-1 rounded-sm transition-all",
              bar.hasVoice ? "bg-primary/60" : "bg-muted-foreground/20"
            )}
            style={{
              height: `${Math.max(4, bar.intensity * 100)}%`,
            }}
          />
        ))}
      </div>

      {/* Playhead */}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-primary shadow-lg z-10 transition-all duration-100"
        style={{ left: `${Math.max(0, Math.min(100, playheadPosition))}%` }}
      >
        <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-primary rounded-full" />
      </div>

      {/* Hover effect */}
      <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity rounded" />
    </div>
  );
}

export function ObjectPlayerTranscript({ timeRange, height, minHeight = 300, maxHeight = 600 }: ObjectPlayerTranscriptProps) {
  // Audio player state
  const { currentDate, resetDate, setIsPlaying, isPlaying } = useAudioPlayer();
  const { volume, setVolume, playbackRate, setPlaybackRate, timeFormat } = useSettingsStore();
  const prevStartTimeRef = useRef<number | null>(null);

  // Transcript state
  const [segments, setSegments] = useState<RenderSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [userScrolling, setUserScrolling] = useState(false);

  const currentSegmentRef = useRef<HTMLDivElement>(null);
  const lastScrolledIndex = useRef<number>(-1);
  const scrollTimeoutRef = useRef<number | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Parse dates
  const startDate = useMemo(() => {
    return typeof timeRange.start === "string"
      ? new Date(timeRange.start)
      : timeRange.start;
  }, [timeRange.start]);

  const endDate = useMemo(() => {
    if (timeRange.end) {
      return typeof timeRange.end === "string" ? new Date(timeRange.end) : timeRange.end;
    }
    return new Date(startDate.getTime() + 60 * 60 * 1000);
  }, [timeRange.end, startDate]);

  // Initialize player to start of time range
  useEffect(() => {
    const startTime = startDate.getTime();
    if (prevStartTimeRef.current !== startTime) {
      resetDate(startDate);
      prevStartTimeRef.current = startTime;
    }
  }, [startDate, resetDate]);

  // Stop playback when currentDate reaches endDate
  useEffect(() => {
    if (!isPlaying || !currentDate) return;

    if (currentDate.getTime() >= endDate.getTime()) {
      setIsPlaying(false);
      resetDate(endDate);
    }
  }, [currentDate, endDate, isPlaying, setIsPlaying, resetDate]);

  // Fetch transcripts
  useEffect(() => {
    async function fetchTranscripts() {
      setLoading(true);
      setError(null);

      try {
        const docs: TranscriptionDoc[] = await callResource("mongo", {
          action: "find",
          collection: "transcriptions",
          query: {
            start: { $lt: endDate },
            end: { $gt: startDate },
          },
          options: { sort: { start: 1 }, limit: 500 },
        });

        const rendered: RenderSegment[] = [];
        for (const doc of docs) {
          for (const s of doc.segments || []) {
            const absStart = new Date(new Date(doc.start).getTime() + s.start * 1000);
            const absEnd = new Date(new Date(doc.start).getTime() + s.end * 1000);
            if (absEnd > startDate && absStart < endDate) {
              rendered.push({
                time: absStart,
                endTime: absEnd,
                text: (s.text || "").replace(/\n/g, " ").trim(),
              });
            }
          }
        }

        rendered.sort((a, b) => a.time.getTime() - b.time.getTime());
        setSegments(rendered);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch transcripts");
      } finally {
        setLoading(false);
      }
    }

    fetchTranscripts();
  }, [startDate, endDate]);

  // Find current segment
  const currentSegmentIndex = segments.findIndex(seg =>
    currentDate &&
    currentDate >= seg.time &&
    currentDate < seg.endTime
  );

  // Handle user scroll - temporarily disable auto-scroll
  const handleScroll = useCallback(() => {
    if (!syncEnabled) return;

    setUserScrolling(true);

    // Clear any existing timeout
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    // Re-enable auto-scroll after 3 seconds of no scrolling
    scrollTimeoutRef.current = globalThis.setTimeout(() => {
      setUserScrolling(false);
    }, 3000);
  }, [syncEnabled]);

  // Scroll to segment within container only (doesn't scroll the whole page)
  const scrollToSegmentInContainer = useCallback((element: HTMLElement) => {
    const scrollViewport = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]');
    if (!scrollViewport || !element) return;

    const elementTop = element.offsetTop;
    const containerHeight = scrollViewport.clientHeight;
    const elementHeight = element.offsetHeight;
    const targetScroll = elementTop - (containerHeight / 2) + (elementHeight / 2);

    scrollViewport.scrollTo({ top: targetScroll, behavior: 'smooth' });
  }, []);

  // Auto-scroll to current segment
  useEffect(() => {
    if (syncEnabled && !userScrolling && currentSegmentIndex >= 0 && currentSegmentIndex !== lastScrolledIndex.current) {
      lastScrolledIndex.current = currentSegmentIndex;
      setTimeout(() => {
        if (currentSegmentRef.current) {
          scrollToSegmentInContainer(currentSegmentRef.current);
        }
      }, 100);
    }
  }, [currentSegmentIndex, syncEnabled, userScrolling, scrollToSegmentInContainer]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  const handlePlayFromSegment = (segmentTime: Date) => {
    resetDate(segmentTime);
    setIsPlaying(true);
    setUserScrolling(false); // Re-enable sync when user clicks a segment
    lastScrolledIndex.current = -1; // Reset to force scroll
  };

  const handleVolumeChange = (value: number[]) => {
    setVolume(value[0]);
  };

  const handleSpeedChange = (value: string) => {
    setPlaybackRate(parseFloat(value));
  };

  // Calculate progress
  const getProgress = () => {
    if (!currentDate || !startDate) return 0;
    const current = currentDate.getTime();
    const start = startDate.getTime();
    const end = endDate.getTime();
    const progress = ((current - start) / (end - start)) * 100;
    return Math.max(0, Math.min(100, progress));
  };

  // Format elapsed time
  const getElapsedTime = () => {
    if (!currentDate || !startDate) return "0:00";
    const elapsedMs = currentDate.getTime() - startDate.getTime();
    if (elapsedMs < 0) return "0:00";
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  // Get total duration
  const getTotalDuration = () => {
    const durationMs = endDate.getTime() - startDate.getTime();
    const totalSeconds = Math.floor(durationMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  // Handle progress bar click
  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const duration = endDate.getTime() - startDate.getTime();
    const targetTime = new Date(startDate.getTime() + duration * percentage);
    resetDate(targetTime);
  };

  // Format segment duration
  const formatDuration = (start: Date, end: Date): string => {
    const diffMs = end.getTime() - start.getTime();
    const diffSeconds = Math.floor(diffMs / 1000);
    if (diffSeconds < 60) return `${diffSeconds}s`;
    const minutes = Math.floor(diffSeconds / 60);
    const seconds = diffSeconds % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  };

  const containerStyle = height
    ? { height: `${height}px` }
    : { minHeight: `${minHeight}px`, maxHeight: `${maxHeight}px` };

  return (
    <div className="border rounded-lg bg-muted/30 flex flex-col" style={containerStyle}>
      {/* Sticky Player Section */}
      <div className="flex-shrink-0 p-4 border-b bg-gradient-to-r from-muted/50 to-muted/30 rounded-t-lg space-y-3">
        {/* Waveform visualization */}
        {segments.length > 0 && (
          <WaveformDisplay
            segments={segments}
            startDate={startDate}
            endDate={endDate}
            currentDate={currentDate}
            onSeek={resetDate}
          />
        )}

        <div className="flex flex-wrap items-center gap-4">
          {/* Play button */}
          <PlayPauseButton />

          {/* Progress bar section */}
          <div className="flex-1 min-w-[200px]">
            <div
              className="h-2 bg-background rounded-full overflow-hidden cursor-pointer hover:h-3 transition-all"
              onClick={handleProgressClick}
              title="Click to seek"
            >
              <div
                className="h-full bg-primary transition-all duration-200"
                style={{ width: `${getProgress()}%` }}
              />
            </div>
          </div>

          {/* Time display */}
          <div className="flex flex-col items-end">
            <span className="text-sm font-mono font-medium">
              {getElapsedTime()} / {getTotalDuration()}
            </span>
            <span className="text-xs text-muted-foreground">
              {currentDate ? formatTime(currentDate, timeFormat) : "Ready"}
            </span>
          </div>

          {/* Divider */}
          <div className="h-8 w-px bg-border hidden sm:block" />

          {/* Speed selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground hidden sm:inline">Speed</span>
            <Select
              value={playbackRate.toString()}
              onValueChange={handleSpeedChange}
            >
              <SelectTrigger className="w-[70px] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SPEED_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value.toString()}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Volume slider */}
          <div className="flex items-center gap-2 min-w-[120px]">
            <Volume2 className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <Slider
              value={[volume]}
              onValueChange={handleVolumeChange}
              min={0}
              max={2}
              step={0.01}
              className="flex-1"
            />
          </div>

          {/* Divider */}
          <div className="h-8 w-px bg-border hidden sm:block" />

          {/* View in Timeline button */}
          <Button
            variant="outline"
            size="sm"
            asChild
            className="h-8 text-xs"
          >
            <Link to={`/timeline?start=${startDate.getTime()}&end=${endDate.getTime()}`}>
              <Calendar className="w-3.5 h-3.5 mr-1.5" />
              View in Timeline
            </Link>
          </Button>
        </div>
      </div>

      {/* Transcript Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-b">
        <h3 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
          <FileText className="w-4 h-4" />
          Transcript
          {!loading && segments.length > 0 && (
            <span className="text-xs font-normal">({segments.length} segments)</span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          {syncEnabled && isPlaying && !userScrolling && (
            <span className="text-xs text-primary animate-pulse">Following</span>
          )}
          {syncEnabled && userScrolling && (
            <span className="text-xs text-muted-foreground">Paused</span>
          )}
          <Button
            variant={syncEnabled ? "secondary" : "ghost"}
            size="sm"
            onClick={() => {
              setSyncEnabled(!syncEnabled);
              setUserScrolling(false);
            }}
            title={syncEnabled ? "Sync enabled - click to disable" : "Sync disabled - click to enable"}
            className="h-7 px-2 gap-1"
          >
            {syncEnabled ? (
              <Link2 className="w-3.5 h-3.5" />
            ) : (
              <Link2Off className="w-3.5 h-3.5" />
            )}
            <span className="text-xs">{syncEnabled ? "Sync" : "No sync"}</span>
          </Button>
        </div>
      </div>

      {/* Scrollable Transcript Area */}
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="p-4 space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : error ? (
          <div className="p-4">
            <p className="text-sm text-red-500">{error}</p>
          </div>
        ) : segments.length === 0 ? (
          <div className="p-4">
            <p className="text-sm text-muted-foreground text-center py-4">
              No transcript available for this time range
            </p>
          </div>
        ) : (
          <ScrollArea
            className="h-full [&>[data-radix-scroll-area-viewport]]:!overflow-y-scroll"
            ref={scrollAreaRef}
            onScrollCapture={handleScroll}
          >
            <div className="p-3 space-y-1">
              {segments.map((seg, idx) => {
                const isCurrentSegment = syncEnabled && idx === currentSegmentIndex;
                return (
                  <div
                    key={idx}
                    ref={isCurrentSegment ? currentSegmentRef : null}
                    className={cn(
                      "group flex items-start gap-2 p-2 rounded transition-colors cursor-pointer",
                      isCurrentSegment
                        ? "bg-primary/10 border-l-2 border-primary"
                        : "hover:bg-muted/80"
                    )}
                    onClick={() => handlePlayFromSegment(seg.time)}
                  >
                    <div className={cn(
                      "flex-shrink-0 w-6 h-6 flex items-center justify-center",
                      isCurrentSegment ? "text-primary" : "text-muted-foreground opacity-0 group-hover:opacity-100"
                    )}>
                      <Play className="w-3 h-3" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={cn(
                          "text-xs font-mono",
                          isCurrentSegment ? "text-primary font-medium" : "text-muted-foreground"
                        )}>
                          {formatTime(seg.time, timeFormat)}
                        </span>
                        <span className="text-xs text-muted-foreground/60">
                          ({formatDuration(seg.time, seg.endTime)})
                        </span>
                      </div>
                      <p className={cn(
                        "text-sm leading-relaxed",
                        isCurrentSegment && "font-medium"
                      )}>{seg.text}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
