import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { useAudioPlayer } from "./player.tsx";

export const PlayPauseButton = ({ showLabel = false }: { showLabel?: boolean }) => {
  const { isPlaying, toggleIsPlaying } = useAudioPlayer();
  const label = isPlaying ? "Pause playback" : "Start playback";

  return (
    <Button aria-label={label} title={label} onClick={() => toggleIsPlaying()}>
      {isPlaying ? <Pause /> : <Play />}
      {showLabel && (isPlaying ? "Pause" : "Play")}
    </Button>
  );
};
