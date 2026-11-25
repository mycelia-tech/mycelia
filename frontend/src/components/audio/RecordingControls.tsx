import { Button } from "@/components/ui/button";
import { Mic, Square } from "lucide-react";
import type { AudioRecordingReturn } from "@/hooks/useAudioRecording";

interface RecordingControlsProps {
  recording: AudioRecordingReturn;
}

export const RecordingControls = ({ recording }: RecordingControlsProps) => {
  const { isRecording, currentStep, startRecording, stopRecording } = recording;

  const isDisabled = currentStep !== "idle" && currentStep !== "error";
  const isLoading = currentStep === "mic" || currentStep === "websocket" ||
    currentStep === "audio-start" || currentStep === "stopping";

  return (
    <div className="flex flex-wrap items-center gap-3">
      {!isRecording
        ? (
          <Button
            onClick={startRecording}
            disabled={isDisabled || !recording.canAccessMicrophone}
          >
            {isLoading
              ? (
                <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              )
              : <Mic className="size-4" />}
            Start recording
          </Button>
        )
        : (
          <Button
            onClick={stopRecording}
            variant="destructive"
          >
            <Square className="size-4" />
            Stop recording
          </Button>
        )}

      {!recording.canAccessMicrophone && (
        <p className="text-sm text-muted-foreground text-center">
          Microphone access requires HTTPS or localhost
        </p>
      )}
    </div>
  );
};
