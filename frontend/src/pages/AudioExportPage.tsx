import { useState } from "react";
import { apiClient } from "@/lib/api";
import { SmartBackButton } from "@/components/SmartBackButton";
import { DateRangePicker } from "@/components/DateRangePicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Download, Loader2 } from "lucide-react";
import { Separator } from "@/components/ui/separator";

const AudioExportPage = () => {
  const [startDate, setStartDate] = useState<Date | null>(
    new Date(Date.now() - 3600000),
  );
  const [endDate, setEndDate] = useState<Date | null>(new Date());
  const [originalId, setOriginalId] = useState<string>("");
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    if (!startDate || !endDate) {
      setError("Please select both start and end times");
      return;
    }

    if (endDate <= startDate) {
      setError("End time must be after start time");
      return;
    }

    setError(null);
    setDownloading(true);

    try {
      const startParam = (startDate.getTime() / 1000).toString();
      const endParam = (endDate.getTime() / 1000).toString();

      let url = `/api/audio/wav?start=${encodeURIComponent(startParam)}&end=${
        encodeURIComponent(endParam)
      }`;

      if (originalId.trim()) {
        url += `&original_id=${encodeURIComponent(originalId.trim())}`;
      }

      const blob = await apiClient.getBlob(url);

      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;

      const startISO = startDate.toISOString().replace(/[:.]/g, "-");
      const endISO = endDate.toISOString().replace(/[:.]/g, "-");
      link.download = `audio_${startISO}_${endISO}.wav`;

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      console.error("Failed to download audio:", err);
      setError(err instanceof Error ? err.message : "Failed to download audio");
    } finally {
      setDownloading(false);
    }
  };

  const duration = startDate && endDate && endDate > startDate
    ? endDate.getTime() - startDate.getTime()
    : 0;
  const durationSeconds = duration / 1000;
  const durationMinutes = Math.floor(durationSeconds / 60);
  const durationSecondsRemainder = durationSeconds % 60;

  return (
    <div className="w-full max-w-2xl space-y-4">
      <div className="flex items-center gap-4">
        <SmartBackButton defaultPath="/audio" />
        <h1 className="text-2xl font-semibold tracking-tight">Export Audio</h1>
      </div>

      <div className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
        <div className="space-y-4">
          {startDate && endDate && (
            <DateRangePicker
              label="Audio range *"
              value={{ start: startDate, end: endDate }}
              onChange={(value) => {
                setStartDate(value.start);
                if (value.end) setEndDate(value.end);
              }}
              precision="second"
              showAudioTimeline
            />
          )}

          {startDate && endDate && endDate > startDate && (
            <div className="text-sm text-muted-foreground">
              Duration: {durationMinutes > 0
                ? `${durationMinutes}m ${durationSecondsRemainder.toFixed(1)}s`
                : `${durationSecondsRemainder.toFixed(2)}s`}
            </div>
          )}

          <Separator />

          <div className="space-y-2">
            <Label htmlFor="originalId">Original Audio ID (Optional)</Label>
            <Input
              id="originalId"
              value={originalId}
              onChange={(e) => setOriginalId(e.target.value)}
              placeholder="MongoDB ObjectId of original audio file"
              className="font-mono"
            />
            <p className="text-sm text-muted-foreground">
              Leave empty to export from all audio chunks in the time range
            </p>
          </div>
        </div>

        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-red-700 dark:text-red-300 text-sm">
            {error}
          </div>
        )}

        <div className="flex justify-end border-t pt-4">
          <Button
            onClick={handleDownload}
            disabled={!startDate || !endDate || endDate <= startDate ||
              downloading}
          >
            {downloading
              ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Downloading...
                </>
              )
              : (
                <>
                  <Download className="w-4 h-4 mr-2" />
                  Download WAV
                </>
              )}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default AudioExportPage;
