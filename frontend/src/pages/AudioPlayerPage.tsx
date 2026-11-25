import { useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { PlayPauseButton } from "@/modules/audio/PlayPauseButton.tsx";
import { useAudioPlayer } from "@/modules/audio/player.tsx";
import { useSettingsStore } from "@/stores/settingsStore.ts";

const SPEED_OPTIONS = [
  { value: 0.5, label: "x0.5" },
  { value: 0.75, label: "x0.75" },
  { value: 1, label: "x1" },
  { value: 1.25, label: "x1.25" },
  { value: 1.5, label: "x1.5" },
  { value: 1.75, label: "x1.75" },
  { value: 2, label: "x2" },
  { value: 2.5, label: "x2.5" },
  { value: 3, label: "x3" },
];

export default function AudioPlayerPage() {
  const { currentDate, isPlaying, resetDate } = useAudioPlayer();
  const { volume, setVolume, playbackRate, setPlaybackRate } =
    useSettingsStore();
  const [jumpToDate, setJumpToDate] = useState<Date | null>(
    currentDate || new Date(),
  );
  const prevIsPlayingRef = useRef(isPlaying);

  useEffect(() => {
    if (currentDate) {
      setJumpToDate(currentDate);
    }
  }, [currentDate]);

  useEffect(() => {
    if (!prevIsPlayingRef.current && isPlaying && !currentDate && jumpToDate) {
      resetDate(jumpToDate);
    }
    prevIsPlayingRef.current = isPlaying;
  }, [isPlaying, jumpToDate, currentDate, resetDate]);

  const handleJumpToDateChange = (date: Date | null) => {
    setJumpToDate(date);
    if (date) resetDate(date);
  };

  const handleVolumeChange = (value: number[]) => {
    setVolume(value[0]);
  };

  const handleSpeedChange = (value: string) => {
    setPlaybackRate(parseFloat(value));
  };

  return (
    <div className="w-full max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Audio player</h1>
      <Card>
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="space-y-2">
            <h2 className="font-semibold">Playback position</h2>
            <DateTimePicker
              value={jumpToDate || undefined}
              onChange={handleJumpToDateChange}
              placeholder="Select date and time"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <PlayPauseButton showLabel />
            <label htmlFor="speed-select" className="ml-1 text-sm font-medium">Speed</label>
            <Select
              value={playbackRate.toString()}
              onValueChange={handleSpeedChange}
            >
              <SelectTrigger id="speed-select" className="w-24">
                <SelectValue placeholder="Select speed" />
              </SelectTrigger>
              <SelectContent>
                {SPEED_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value.toString()}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 border-t pt-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Volume2 className="w-5 h-5 text-muted-foreground" />
                <label htmlFor="volume-slider" className="text-sm font-medium">
                  Volume
                </label>
              </div>
              <span className="text-sm text-muted-foreground">
                {Math.round(volume * 100)}%
              </span>
            </div>
            <Slider
              id="volume-slider"
              thumbLabels={["Volume"]}
              thumbValueTexts={[`${Math.round(volume * 100)}%`]}
              value={[volume]}
              onValueChange={handleVolumeChange}
              min={0}
              max={3}
              step={0.01}
              className="h-6 w-full"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0%</span>
              <span>300%</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
