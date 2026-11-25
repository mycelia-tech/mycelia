import { useMemo } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Monitor, Moon, Sun } from "lucide-react";
import { formatTime } from "@/lib/formatTime";
import { TimeZoneSelect } from "@/components/TimeZoneSelect";
import { getBrowserTimeZone, resolveDefaultTimeZone } from "@/lib/timeZones";

const GeneralSettingsPage = () => {
  const {
    theme,
    timeFormat,
    defaultTimeZone,
    transcriptThresholdHours,
    setTheme,
    setTimeFormat,
    setDefaultTimeZone,
    setTranscriptThresholdHours,
  } = useSettingsStore();
  const now = useMemo(() => new Date(), []);

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h2 className="text-2xl font-semibold mb-2">Appearance</h2>
        <p className="text-muted-foreground">
          Choose how Mycelia looks on this device.
        </p>
      </div>

      <div className="rounded-xl border bg-card px-4 sm:px-5">
        <div className="divide-y">
          <div className="space-y-2 py-4">
            <span id="appearance-theme" className="text-sm font-medium">Theme</span>
            <div role="group" aria-labelledby="appearance-theme" className="grid max-w-md grid-cols-3 gap-1.5">
              <Button
                aria-pressed={theme === "light"}
                variant={theme === "light" ? "default" : "outline"}
                onClick={() => setTheme("light")}
                className="min-w-0 gap-1.5 px-2"
              >
                <Sun className="size-4" />
                Light
              </Button>
              <Button
                aria-pressed={theme === "dark"}
                variant={theme === "dark" ? "default" : "outline"}
                onClick={() => setTheme("dark")}
                className="min-w-0 gap-1.5 px-2"
              >
                <Moon className="size-4" />
                Dark
              </Button>
              <Button
                aria-pressed={theme === "system"}
                variant={theme === "system" ? "default" : "outline"}
                onClick={() => setTheme("system")}
                className="min-w-0 gap-1.5 px-2"
              >
                <Monitor className="size-4" />
                System
              </Button>
            </div>
          </div>

          <div className="space-y-2 py-4">
            <Label htmlFor="timeFormat">Time Format</Label>
            <select
              id="timeFormat"
              value={timeFormat}
              onChange={(e) => setTimeFormat(e.target.value as any)}
              className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <optgroup label="Gregorian (Local)">
                <option value="gregorian-local-natural">
                  Natural ({formatTime(now, "gregorian-local-natural")})
                </option>
                <option value="gregorian-local-iso">
                  ISO 8601 ({formatTime(now, "gregorian-local-iso")})
                </option>
                <option value="gregorian-local-verbose">
                  Verbose ({formatTime(now, "gregorian-local-verbose")})
                </option>
                <option value="gregorian-local-european">
                  European ({formatTime(now, "gregorian-local-european")})
                </option>
                <option value="gregorian-local-american">
                  American ({formatTime(now, "gregorian-local-american")})
                </option>
              </optgroup>
              <optgroup label="Gregorian (UTC)">
                <option value="gregorian-utc-iso">
                  ISO 8601 UTC ({formatTime(now, "gregorian-utc-iso")})
                </option>
                <option value="gregorian-utc-verbose">
                  Verbose UTC ({formatTime(now, "gregorian-utc-verbose")})
                </option>
                <option value="gregorian-utc-european">
                  European UTC ({formatTime(now, "gregorian-utc-european")})
                </option>
                <option value="gregorian-utc-american">
                  American UTC ({formatTime(now, "gregorian-utc-american")})
                </option>
              </optgroup>
              <optgroup label="SI Time">
                <option value="si-int">
                  Seconds since epoch ({formatTime(now, "si-int")})
                </option>
                <option value="si-formatted">
                  Formatted SI ({formatTime(now, "si-formatted")})
                </option>
              </optgroup>
            </select>
          </div>

          <div className="space-y-2 py-4">
            <Label htmlFor="defaultTimeZone">Default Time Zone</Label>
            <TimeZoneSelect
              id="defaultTimeZone"
              value={defaultTimeZone}
              onChange={setDefaultTimeZone}
              includeBrowser
            />
            <p className="text-sm text-muted-foreground">
              Used when a timeline instant has no saved time-zone period.
              Current resolved zone:{" "}
              {resolveDefaultTimeZone(defaultTimeZone)}. Device zone:{" "}
              {getBrowserTimeZone()}.
            </p>
          </div>

          <div className="space-y-2 py-4">
            <Label htmlFor="transcriptThreshold">
              Transcript Button Threshold (hours)
            </Label>
            <Input
              id="transcriptThreshold"
              type="number"
              min="0.1"
              max="168"
              step="0.1"
              value={transcriptThresholdHours}
              onChange={(e) => {
                const value = parseFloat(e.target.value);
                if (!isNaN(value) && value > 0) {
                  setTranscriptThresholdHours(value);
                }
              }}
              className="w-32"
            />
            <p className="text-sm text-muted-foreground">
              Time ranges shorter than this duration will show a "Go to
              transcript" button.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GeneralSettingsPage;
