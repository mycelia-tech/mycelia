import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { apiClient, callResource } from "@/lib/api";
import { useSettingsStore } from "@/stores/settingsStore";
import { formatTime } from "@/lib/formatTime";
import { SmartBackButton } from "@/components/SmartBackButton";
import { embeddingToColor } from "@/lib/pcaColor";
import { ObjectId } from "bson";
import { Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import * as d3 from "d3";
import {
  type MatchedSpeakerValue,
  SpeakerAssignmentControl,
} from "@/modules/speakers";
import { normalizeObjectId } from "@/lib/diarization";
import { useAudioPlaybackStore } from "@/stores/audioPlaybackStore";
import { useSelectedVoiceProfile } from "@/hooks/useSelectedVoiceProfile";
import { VoiceProfileContextBar } from "@/components/voice/VoiceProfileContextBar";

interface DiarizationDoc {
  _id: unknown;
  inference_id?: unknown;
  original_id?: unknown;
  original?: unknown;
  start: Date;
  end: Date;
  speaker?: string;
  embedding?: number[];
  duration?: number;
  created_at?: Date;
  matched_speaker?: MatchedSpeakerValue;
  runId?: string;
  speakerIdentity?: {
    state:
      | "identified"
      | "ambiguous"
      | "unknown"
      | "matched"
      | "rejected"
      | "uncertain"
      | "unclassified";
    source?: string;
    annotationId?: unknown;
    profileId?: unknown;
  };
  embeddingSpaceId?: string;
}

interface EmbeddingHeatmapProps {
  embedding: number[];
  color: string;
}

const EmbeddingHeatmap = ({ embedding, color }: EmbeddingHeatmapProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: 300 });

  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver(([{ contentRect }]) => {
      setDimensions({
        width: Math.max(contentRect.width, 400),
        height: 300,
      });
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  const {
    cells,
    colorScale,
    cellSize,
    cols,
    rows,
    absMax,
    heatmapHeight,
    heatmapCenterX,
  } = useMemo(() => {
    const length = embedding.length;
    const cols = Math.round(Math.sqrt(length));
    const rows = Math.ceil(length / cols);

    const padding = 2;
    const availableWidth = dimensions.width - 40;
    const availableHeight = dimensions.height - 80;
    const cellWidth = Math.floor(
      (availableWidth - (cols - 1) * padding) / cols,
    );
    const cellHeight = Math.floor(
      (availableHeight - (rows - 1) * padding) / rows,
    );
    const cellSize = Math.min(cellWidth, cellHeight, 12);

    const min = Math.min(...embedding);
    const max = Math.max(...embedding);
    const absMax = Math.max(Math.abs(min), Math.abs(max));

    const colorScale = d3.scaleSequential(d3.interpolateRdYlBu)
      .domain([absMax, -absMax]);

    const heatmapStartX = 20;
    const heatmapWidth = cols * (cellSize + padding) - padding;
    const heatmapCenterX = heatmapStartX + heatmapWidth / 2;

    const cells = embedding.map((value, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      return {
        index,
        value,
        x: heatmapStartX + col * (cellSize + padding),
        y: 20 + row * (cellSize + padding),
        color: colorScale(value),
      };
    });

    const heatmapHeight = 20 + rows * (cellSize + padding);

    return {
      cells,
      colorScale,
      cellSize,
      cols,
      rows,
      absMax,
      heatmapHeight,
      heatmapCenterX,
    };
  }, [embedding, dimensions]);

  const arrowStartY = heatmapHeight + 20;
  const arrowEndY = arrowStartY + 40;
  const circleRadius = 12;
  const circleY = arrowEndY + circleRadius + 10;

  return (
    <div ref={containerRef} className="w-full overflow-x-auto">
      <svg
        ref={svgRef}
        width={dimensions.width}
        height={circleY + circleRadius + 20}
        className="w-full"
      >
        {cells.map((cell) => (
          <rect
            key={cell.index}
            x={cell.x}
            y={cell.y}
            width={cellSize}
            height={cellSize}
            fill={cell.color}
          />
        ))}

        <line
          x1={heatmapCenterX}
          y1={arrowStartY}
          x2={heatmapCenterX}
          y2={arrowEndY}
          stroke="currentColor"
          strokeWidth="2"
          className="text-muted-foreground"
        />

        <polygon
          points={`${heatmapCenterX},${arrowEndY} ${heatmapCenterX - 6},${
            arrowEndY - 8
          } ${heatmapCenterX + 6},${arrowEndY - 8}`}
          fill="currentColor"
          className="text-muted-foreground"
        />

        <circle
          cx={heatmapCenterX}
          cy={circleY}
          r={circleRadius}
          fill={color}
          stroke="currentColor"
          strokeWidth="1"
          className="text-border"
        />
      </svg>
    </div>
  );
};

const DiarizationDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const voiceSelection = useSelectedVoiceProfile();
  const selectedProfileId = voiceSelection.selectedProfileId;
  const selectedProfileName = voiceSelection.selectedProfile?.name ??
    "selected voice";
  const { timeFormat } = useSettingsStore();
  const [diarization, setDiarization] = useState<DiarizationDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      if (!id) return;

      try {
        const result = await callResource("mongo", {
          action: "findOne",
          collection: "diarizations",
          query: { _id: { $oid: id } },
        });

        if (result) {
          const active = await callResource("speaker-segments", {
            action: "list",
            start: result.start,
            end: result.end,
            ...(selectedProfileId ? { selectedProfileId } : {}),
            segmentId: id,
            limit: 1,
          }) as { segments: DiarizationDoc[] };
          const projected = active.segments.find((segment) =>
            normalizeObjectId(segment._id) === id
          );
          setDiarization(projected ?? result);
        } else {
          setError("Diarization not found");
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to fetch diarization",
        );
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [id, selectedProfileId]);

  const annotateIdentity = async (state: "me" | "not-me" | "clear") => {
    if (!diarization) return;
    setAnnotating(true);
    try {
      if (state === "clear") {
        const annotationId = normalizeObjectId(
          diarization.speakerIdentity?.annotationId,
        );
        if (!annotationId) {
          throw new Error("This segment has no manual annotation");
        }
        await callResource("speaker-segments", {
          action: "delete-annotation",
          id: annotationId,
        });
        setDiarization({ ...diarization, speakerIdentity: undefined });
        return;
      }
      const originalId = normalizeObjectId(
        diarization.original_id ?? diarization.original,
      );
      const segmentId = normalizeObjectId(diarization._id);
      if (!selectedProfileId || !originalId) {
        throw new Error("Select a voice profile and try again");
      }
      await callResource("speaker-segments", {
        action: "annotate",
        originalId,
        segmentId,
        runId: diarization.runId,
        start: diarization.start,
        end: diarization.end,
        ...(state === "me"
          ? { profileId: selectedProfileId, excludedProfileIds: [] }
          : { excludedProfileIds: [selectedProfileId] }),
      });
      setDiarization({
        ...diarization,
        speakerIdentity: {
          state: state === "me" ? "identified" : "rejected",
          source: "manual_projection",
          ...(state === "me" ? { profileId: selectedProfileId } : {}),
        },
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update identity",
      );
    } finally {
      setAnnotating(false);
    }
  };

  const loadAudio = async () => {
    if (!diarization || audioUrl) return;
    console.log("loading audio", diarization);
    setAudioLoading(true);
    try {
      const originalId = diarization.original_id || diarization.original;
      const originalIdStr = normalizeObjectId(originalId);
      if (!originalIdStr) {
        throw new Error("Diarization has no valid original audio ID");
      }

      const startParam = (diarization.start.getTime() / 1000).toString();
      const endParam = (diarization.end.getTime() / 1000).toString();

      const blob = await apiClient.getBlob(
        `/api/audio/wav?start=${encodeURIComponent(startParam)}&end=${
          encodeURIComponent(endParam)
        }&original_id=${encodeURIComponent(originalIdStr)}`,
      );

      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
    } catch (err) {
      console.error("Failed to load audio:", err);
      setError(err instanceof Error ? err.message : "Failed to load audio");
    } finally {
      setAudioLoading(false);
    }
  };

  const handlePlayPause = () => {
    const playbackId = `diarization-detail:${id ?? "unknown"}`;
    if (!audioUrl) {
      loadAudio().then(() => {
        setTimeout(() => {
          if (!audioRef.current) return;
          useAudioPlaybackStore.getState().acquire(
            playbackId,
            () => audioRef.current?.pause(),
          );
          void audioRef.current.play();
        }, 100);
      });
      return;
    }

    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      useAudioPlaybackStore.getState().acquire(
        playbackId,
        () => audioRef.current?.pause(),
      );
      void audioRef.current.play();
    }
  };

  useEffect(() => {
    if (audioUrl && audioRef.current) {
      audioRef.current.load();
    }
  }, [audioUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const playbackId = `diarization-detail:${id ?? "unknown"}`;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => {
      setIsPlaying(false);
      useAudioPlaybackStore.getState().release(playbackId);
    };
    const handleEnded = () => {
      setIsPlaying(false);
      useAudioPlaybackStore.getState().release(playbackId);
    };

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      useAudioPlaybackStore.getState().release(playbackId);
    };
  }, [audioUrl, id]);

  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <SmartBackButton defaultPath="/transcript" />
        </div>
        <div className="border rounded-lg p-8 text-center">
          <p className="text-muted-foreground">Loading diarization...</p>
        </div>
      </div>
    );
  }

  if (error || !diarization) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <SmartBackButton defaultPath="/transcript" />
        </div>
        <div className="border rounded-lg p-8 text-center">
          <p className="text-red-500">{error || "Diarization not found"}</p>
        </div>
      </div>
    );
  }

  const color = embeddingToColor(diarization.embedding) || "#eab308";
  const duration = diarization.end.getTime() - diarization.start.getTime();
  const durationSeconds = duration / 1000;
  const durationMinutes = Math.floor(durationSeconds / 60);
  const durationSecondsRemainder = durationSeconds % 60;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <VoiceProfileContextBar selection={voiceSelection} compact />
      <div className="flex items-center gap-4">
        <SmartBackButton defaultPath="/transcript" />
        <h1 className="text-3xl font-bold">Diarization</h1>
      </div>

      <div className="border rounded-lg p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-full space-y-3">
            <div className="font-semibold">Speaker Identity</div>
            <SpeakerAssignmentControl
              segmentId={diarization._id}
              originalId={diarization.original_id ?? diarization.original}
              speaker={diarization.speaker}
              embedding={diarization.embedding}
              duration={diarization.duration ?? durationSeconds}
              matchedSpeaker={diarization.matched_speaker}
              embeddingSpaceId={diarization.embeddingSpaceId}
              onChanged={(matchedSpeaker) =>
                setDiarization((current) =>
                  current
                    ? { ...current, matched_speaker: matchedSpeaker }
                    : current
                )}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => void annotateIdentity("me")}
                disabled={annotating || !selectedProfileId}
              >
                This is {selectedProfileName}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void annotateIdentity("not-me")}
                disabled={annotating || !selectedProfileId}
              >
                Not {selectedProfileName}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void annotateIdentity("clear")}
                disabled={annotating ||
                  diarization.speakerIdentity?.source !== "manual_projection"}
              >
                Clear manual label
              </Button>
              {diarization.speakerIdentity && (
                <span className="self-center text-xs text-muted-foreground">
                  {diarization.speakerIdentity.state} ·{" "}
                  {diarization.speakerIdentity.source}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="pt-4 border-t">
          <div className="text-sm font-medium text-muted-foreground mb-3">
            Audio Player
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={handlePlayPause}
              disabled={audioLoading}
              size="lg"
              className="flex-shrink-0"
            >
              {audioLoading
                ? <Loader2 className="w-5 h-5 animate-spin" />
                : isPlaying
                ? <Pause className="w-5 h-5" />
                : <Play className="w-5 h-5" />}
            </Button>
            <div className="flex-1">
              {audioUrl && (
                <audio
                  ref={audioRef}
                  src={audioUrl || undefined}
                  className="w-full"
                  controls
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                />
              )}
            </div>
          </div>
          {!audioUrl && !audioLoading && (
            <p className="text-xs text-muted-foreground mt-2">
              Click play to load and play this diarized segment
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4 pt-4 border-t">
          <div>
            <div className="text-sm font-medium text-muted-foreground">
              Start Time
            </div>
            <div className="text-lg">
              {formatTime(diarization.start, timeFormat)}
            </div>
          </div>
          <div>
            <div className="text-sm font-medium text-muted-foreground">
              End Time
            </div>
            <div className="text-lg">
              {formatTime(diarization.end, timeFormat)}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 pt-4 border-t">
          <div>
            <div className="text-sm font-medium text-muted-foreground mb-1">
              Duration
            </div>
            <div className="text-lg">
              {durationMinutes > 0
                ? `${durationMinutes}m ${durationSecondsRemainder.toFixed(0)}s`
                : `${durationSecondsRemainder.toFixed(2)}s`}
            </div>
          </div>
          {diarization.created_at && (
            <div>
              <div className="text-sm font-medium text-muted-foreground mb-1">
                Processed At
              </div>
              <div className="text-lg">
                {formatTime(diarization.created_at, timeFormat)}
              </div>
            </div>
          )}
        </div>

        <div className="pt-4 border-t">
          <div className="text-sm font-medium text-muted-foreground mb-1">
            Segment ID
          </div>
          <div className="text-sm font-mono break-all">
            {diarization._id instanceof ObjectId
              ? diarization._id.toString()
              : String(diarization._id)}
          </div>
        </div>

        {diarization.inference_id != null && (
          <div className="pt-4 border-t">
            <div className="text-sm font-medium text-muted-foreground mb-1">
              Inference ID
            </div>
            <div className="text-sm font-mono break-all">
              {diarization.inference_id instanceof ObjectId
                ? diarization.inference_id.toString()
                : String(diarization.inference_id)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Groups segments from the same diarization run
            </div>
          </div>
        )}

        <div className="pt-4 border-t">
          <div className="text-sm font-medium text-muted-foreground mb-1">
            Original Audio
          </div>
          <div className="text-sm font-mono break-all">
            {(() => {
              const original = diarization.original_id || diarization.original;
              return original instanceof ObjectId
                ? original.toString()
                : String(original);
            })()}
          </div>
        </div>

        {diarization.embedding && (
          <div className="pt-4 border-t">
            <div className="text-sm font-medium text-muted-foreground mb-2">
              Embedding Vector
            </div>
            <EmbeddingHeatmap embedding={diarization.embedding} color={color} />
          </div>
        )}
      </div>
    </div>
  );
};

export default DiarizationDetailPage;
