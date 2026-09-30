import { useEffect, useRef, useState } from "react";
import { Gauge, Volume2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

  const formatDate = (date: Date | null) => {
    if (!date) return "Not playing";
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 py-8">
      <Card>
        <CardHeader>
          <CardTitle>Player Controls</CardTitle>
        </CardHeader>
        <CardContent className="space-y-8">
          <div className="flex gap-4">
            <PlayPauseButton />
            <Select
              value={playbackRate.toString()}
              onValueChange={handleSpeedChange}
            >
              <SelectTrigger id="speed-select" className="w-full">
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

          <div className="space-y-4">
            <DateTimePicker
              value={jumpToDate || undefined}
              onChange={handleJumpToDateChange}
              placeholder="Select date and time"
            />
          </div>

          <div className="space-y-4">
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
              value={[volume]}
              onValueChange={handleVolumeChange}
              min={0}
              max={3}
              step={0.01}
              className="w-full"
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
