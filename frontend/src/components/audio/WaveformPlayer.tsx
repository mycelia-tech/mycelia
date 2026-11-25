import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { apiClient } from "@/lib/api";
import { useAudioPlaybackStore } from "@/stores/audioPlaybackStore";

type CachedWaveformAudio = {
  arrayBuffer: ArrayBuffer;
  contentType: string;
};

const waveformAudioCache = new Map<string, Promise<CachedWaveformAudio>>();
const MAX_WAVEFORM_AUDIO_CACHE_ITEMS = 8;

function loadWaveformAudio(
  audioUrl: string,
  signal?: AbortSignal,
): Promise<CachedWaveformAudio> {
  const cached = waveformAudioCache.get(audioUrl);
  if (cached) return cached;
  const request = apiClient.fetch(audioUrl, signal ? { signal } : undefined)
    .then(async (response) => ({
      arrayBuffer: await response.arrayBuffer(),
      contentType: response.headers.get("content-type") || "audio/wav",
    }));
  // React Strict Mode intentionally aborts the first mounted effect. Do not
  // put an abortable component request in the shared cache, otherwise its
  // rejected promise poisons the second mount. Background preloads have no
  // component signal and are safe to share.
  if (signal) return request;
  const cachedRequest = request.catch((error) => {
    waveformAudioCache.delete(audioUrl);
    throw error;
  });
  waveformAudioCache.set(audioUrl, cachedRequest);
  while (waveformAudioCache.size > MAX_WAVEFORM_AUDIO_CACHE_ITEMS) {
    const oldest = waveformAudioCache.keys().next().value;
    if (typeof oldest !== "string") break;
    waveformAudioCache.delete(oldest);
  }
  return cachedRequest;
}

/** Warm authenticated audio while the reviewer is still listening. */
export function preloadWaveformAudio(audioUrl: string): void {
  void loadWaveformAudio(audioUrl).catch(() => {
    // The mounted player will retry and render its normal error state.
  });
}

interface WaveformPlayerProps {
  audioUrl: string;
  duration?: number;
  className?: string;
  autoPlay?: boolean;
  onEnded?: () => void;
  ariaLabel?: string;
}

export interface WaveformPlayerHandle {
  play: () => Promise<void>;
  pause: () => void;
  togglePlayback: () => void;
}

export const WaveformPlayer = forwardRef<
  WaveformPlayerHandle,
  WaveformPlayerProps
>(function WaveformPlayer(
  {
    audioUrl,
    duration: initialDuration,
    className,
    autoPlay = false,
    onEnded,
    ariaLabel = "Play audio segment",
  },
  ref,
) {
  const playbackId = useId();
  const [isLoading, setIsLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(initialDuration || 0);
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const onEndedRef = useRef(onEnded);

  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  const playAudio = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    useAudioPlaybackStore.getState().acquire(
      playbackId,
      () => audio.pause(),
    );
    try {
      await audio.play();
    } catch {
      setIsPlaying(false);
      useAudioPlaybackStore.getState().release(playbackId);
    }
  }, [playbackId]);

  const pauseAudio = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const togglePlayback = useCallback(() => {
    if (!audioRef.current) return;
    if (audioRef.current.paused) {
      void playAudio();
    } else {
      pauseAudio();
    }
  }, [pauseAudio, playAudio]);

  useImperativeHandle(ref, () => ({
    play: playAudio,
    pause: pauseAudio,
    togglePlayback,
  }), [pauseAudio, playAudio, togglePlayback]);

  // Load audio and extract waveform data
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let loadedAudio: HTMLAudioElement | null = null;
    let loadedBlobUrl: string | null = null;
    let loadedAudioContext: AudioContext | null = null;
    let removeAudioListeners = () => {};

    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(initialDuration || 0);
    setWaveformData([]);

    const loadAudio = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Fetch audio with auth headers
        const { arrayBuffer, contentType } = await loadWaveformAudio(
          audioUrl,
          controller.signal,
        );
        if (disposed) return;

        // Create a blob URL for the Audio element
        const blob = new Blob([arrayBuffer], {
          type: contentType,
        });
        const blobUrl = URL.createObjectURL(blob);
        loadedBlobUrl = blobUrl;

        // Create audio element for playback using blob URL
        const audio = new Audio(blobUrl);
        loadedAudio = audio;
        audioRef.current = audio;

        const handleLoadedMetadata = () => {
          setDuration(audio.duration);
        };
        const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
        const handleEnded = () => {
          setIsPlaying(false);
          setCurrentTime(0);
          useAudioPlaybackStore.getState().release(playbackId);
          onEndedRef.current?.();
        };
        const handlePlay = () => setIsPlaying(true);
        const handlePause = () => {
          setIsPlaying(false);
          setCurrentTime(audio.currentTime);
          useAudioPlaybackStore.getState().release(playbackId);
        };

        audio.addEventListener("loadedmetadata", handleLoadedMetadata);
        audio.addEventListener("durationchange", handleLoadedMetadata);
        audio.addEventListener("timeupdate", handleTimeUpdate);
        audio.addEventListener("ended", handleEnded);
        audio.addEventListener("play", handlePlay);
        audio.addEventListener("pause", handlePause);
        removeAudioListeners = () => {
          audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
          audio.removeEventListener("durationchange", handleLoadedMetadata);
          audio.removeEventListener("timeupdate", handleTimeUpdate);
          audio.removeEventListener("ended", handleEnded);
          audio.removeEventListener("play", handlePlay);
          audio.removeEventListener("pause", handlePause);
        };

        const audioContext = new AudioContext();
        loadedAudioContext = audioContext;
        const audioBuffer = await audioContext.decodeAudioData(
          arrayBuffer.slice(0),
        );
        await audioContext.close();
        loadedAudioContext = null;
        if (disposed) {
          removeAudioListeners();
          audio.pause();
          return;
        }

        // Extract waveform peaks
        const channelData = audioBuffer.getChannelData(0);
        const samples = 100; // Number of bars in waveform
        const blockSize = Math.max(
          1,
          Math.floor(channelData.length / samples),
        );
        const peaks: number[] = [];

        for (let i = 0; i < samples; i++) {
          const start = blockSize * i;
          let max = 0;
          for (let j = 0; j < blockSize; j++) {
            const abs = Math.abs(channelData[start + j]);
            if (abs > max) max = abs;
          }
          peaks.push(max);
        }

        // Normalize peaks
        const maxPeak = Math.max(...peaks, Number.EPSILON);
        const normalizedPeaks = peaks.map((p) => p / maxPeak);

        setWaveformData(normalizedPeaks);
        setDuration(audioBuffer.duration);
        setIsLoading(false);
      } catch (err) {
        if (loadedAudioContext) {
          void loadedAudioContext.close();
          loadedAudioContext = null;
        }
        if (disposed || controller.signal.aborted) return;
        console.error("Error loading audio:", err);
        setError("Failed to load audio");
        setIsLoading(false);
      }
    };

    loadAudio();

    return () => {
      disposed = true;
      controller.abort();
      removeAudioListeners();
      if (loadedAudio) {
        loadedAudio.pause();
      }
      if (loadedAudioContext) {
        void loadedAudioContext.close();
      }
      if (audioRef.current === loadedAudio) {
        audioRef.current = null;
      }
      useAudioPlaybackStore.getState().release(playbackId);
      if (loadedBlobUrl) {
        URL.revokeObjectURL(loadedBlobUrl);
      }
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [audioUrl, initialDuration, playbackId]);

  useEffect(() => {
    if (!isLoading && autoPlay) {
      void playAudio();
    }
  }, [autoPlay, isLoading, playAudio]);

  // Draw waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || waveformData.length === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const barWidth = width / waveformData.length;
    ctx.clearRect(0, 0, width, height);

    // Draw bars
    waveformData.forEach((peak, i) => {
      const x = i * barWidth;
      const barHeight = Math.max(2, peak * (height - 4));
      const y = (height - barHeight) / 2;

      ctx.fillStyle = "rgba(148, 163, 184, 0.45)";
      ctx.fillRect(x + 1, y, barWidth - 2, barHeight);
    });
  }, [waveformData]);

  // Update time during playback
  const updateTime = useCallback(() => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
      if (isPlaying) {
        animationRef.current = requestAnimationFrame(updateTime);
      }
    }
  }, [isPlaying]);

  useEffect(() => {
    if (isPlaying) {
      animationRef.current = requestAnimationFrame(updateTime);
    } else if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isPlaying, updateTime]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!audioRef.current || !canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = x / rect.width;
    const newTime = ratio * duration;

    audioRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };
  const progressPercent = duration > 0
    ? Math.max(0, Math.min(100, currentTime / duration * 100))
    : 0;

  if (error) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 p-2 text-sm text-destructive",
          className,
        )}
      >
        <span>{error}</span>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        onClick={togglePlayback}
        disabled={isLoading}
        aria-label={isPlaying ? `Pause ${ariaLabel}` : ariaLabel}
      >
        {isLoading
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : isPlaying
          ? <Pause className="h-4 w-4" />
          : <Play className="h-4 w-4" />}
      </Button>

      <div
        className="relative h-8 min-w-0 flex-1 overflow-hidden rounded bg-muted/20"
        role="progressbar"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, Math.round(duration * 10) / 10)}
        aria-valuenow={Math.max(0, Math.round(currentTime * 10) / 10)}
        aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-8 w-full cursor-pointer"
          onClick={handleCanvasClick}
        />
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-primary/15"
          style={{ width: `${progressPercent}%` }}
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-primary shadow-[0_0_0_1px_var(--background)]"
          style={{ left: `${Math.min(99.5, progressPercent)}%` }}
          aria-hidden="true"
        />
      </div>

      <span className="text-xs text-muted-foreground shrink-0 w-16 text-right">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
    </div>
  );
});

export default WaveformPlayer;
