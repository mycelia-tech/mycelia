import { useMemo, useState } from "react";
import { Clock3, Loader2, MapPin, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TimeZoneSelect } from "@/components/TimeZoneSelect";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTimelineTimeZoneStore } from "@/stores/timelineTimeZoneStore";
import { useTimelineTimeZone } from "@/hooks/useTimelineTimeZone";
import {
  getPeriodId,
  getShortTimeZoneName,
  getTimeZoneSearchOptions,
  type TimelineTimeZonePeriod,
} from "@/lib/timeZones";

interface TimelineTimeZoneControlProps {
  selectionStart?: Date;
  selectionEnd?: Date;
}

function describePeriod(period: TimelineTimeZonePeriod) {
  const start = new Date(period.start).toLocaleDateString(undefined, {
    timeZone: period.timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const end = new Date(period.end).toLocaleDateString(undefined, {
    timeZone: period.timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `${start} – ${end}`;
}

export function TimelineTimeZoneControl({
  selectionStart,
  selectionEnd,
}: TimelineTimeZoneControlProps) {
  const mode = useSettingsStore((state) => state.timelineTimeZoneMode);
  const override = useSettingsStore((state) => state.timelineTimeZoneOverride);
  const setMode = useSettingsStore((state) => state.setTimelineTimeZoneMode);
  const setOverride = useSettingsStore(
    (state) => state.setTimelineTimeZoneOverride,
  );
  const favoriteTimeZones = useSettingsStore((state) =>
    state.favoriteTimeZones
  );
  const { activeTimeZone, browserTimeZone, periods } = useTimelineTimeZone();
  const createPeriod = useTimelineTimeZoneStore((state) => state.createPeriod);
  const deletePeriod = useTimelineTimeZoneStore((state) => state.deletePeriod);
  const saving = useTimelineTimeZoneStore((state) => state.saving);
  const error = useTimelineTimeZoneStore((state) => state.error);
  const [periodTimeZone, setPeriodTimeZone] = useState(activeTimeZone);
  const [location, setLocation] = useState("");
  const [saved, setSaved] = useState(false);
  const favoriteOptions = useMemo(() => {
    const options = getTimeZoneSearchOptions();
    return favoriteTimeZones.flatMap((timeZone) => {
      const option = options.find((item) => item.timeZone === timeZone);
      return option ? [option] : [];
    });
  }, [favoriteTimeZones]);

  const selectedPeriods = useMemo(() => {
    if (!selectionStart || !selectionEnd) return periods;
    return periods.filter((period) =>
      new Date(period.start) < selectionEnd &&
      new Date(period.end) > selectionStart
    );
  }, [periods, selectionEnd, selectionStart]);

  const displayValue = mode === "fixed" ? `fixed:${override}` : mode;

  const handleDisplayChange = (value: string) => {
    if (value === "contextual" || value === "browser") {
      setMode(value);
      return;
    }
    setOverride(value.slice("fixed:".length));
    setMode("fixed");
  };

  const handleSave = async () => {
    if (!selectionStart || !selectionEnd) return;
    try {
      await createPeriod({
        start: selectionStart,
        end: selectionEnd,
        timeZone: periodTimeZone,
        location: location.trim() ? { name: location.trim() } : undefined,
        source: "manual",
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // The store exposes the request error in this popover.
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Clock3 className="h-4 w-4" />
          <span className="hidden lg:inline">{activeTimeZone}</span>
          <span className="text-xs text-muted-foreground">
            {getShortTimeZoneName(new Date(), activeTimeZone)}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[var(--radix-popover-content-available-height)] w-[min(26rem,calc(100vw-2rem))] space-y-5 overflow-y-auto">
        <div className="space-y-1">
          <h3 className="font-medium">Timeline time zone</h3>
          <p className="text-xs text-muted-foreground">
            Change only how instants are displayed; recorded timestamps remain
            unchanged.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="timeline-time-zone-mode">Display as</Label>
          <select
            id="timeline-time-zone-mode"
            value={displayValue}
            onChange={(event) => handleDisplayChange(event.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
          >
            <option value="contextual">Recorded period, then default</option>
            <option value="browser">Current device ({browserTimeZone})</option>
            <option value={`fixed:${override}`}>Specific: {override}</option>
          </select>
          {mode === "fixed" && (
            <TimeZoneSelect value={override} onChange={setOverride} />
          )}
        </div>

        <div className="border-t pt-4 space-y-3">
          <div>
            <Label>Save time zone for selected period</Label>
            <p className="text-xs text-muted-foreground mt-1">
              {selectionStart && selectionEnd
                ? "This context is stored in Mycelia and used by contextual display."
                : "Select a range on the time axis first."}
            </p>
          </div>
          <TimeZoneSelect
            value={periodTimeZone}
            onChange={setPeriodTimeZone}
            onPlaceSelect={(place) => {
              if (!location.trim()) setLocation(place);
            }}
            disabled={!selectionStart || !selectionEnd}
          />
          {favoriteOptions.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Quick favorites</p>
              <div className="flex flex-wrap gap-1.5">
                {favoriteOptions.map((option) => (
                  <Button
                    key={option.timeZone}
                    type="button"
                    size="sm"
                    variant={periodTimeZone === option.timeZone
                      ? "default"
                      : "outline"}
                    className="h-7 px-2 text-xs"
                    disabled={!selectionStart || !selectionEnd}
                    onClick={() => {
                      setPeriodTimeZone(option.timeZone);
                      if (!location.trim()) setLocation(option.city);
                    }}
                  >
                    {option.city}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className="relative">
            <MapPin className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              disabled={!selectionStart || !selectionEnd}
              placeholder="Place (optional), e.g. Metz"
              className="pl-9"
            />
          </div>
          <Button
            size="sm"
            className="w-full"
            disabled={!selectionStart || !selectionEnd || saving}
            onClick={handleSave}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {saved ? "Saved" : "Save period"}
          </Button>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        {selectedPeriods.length > 0 && (
          <div className="border-t pt-4 space-y-2">
            <Label>
              Saved periods {selectionStart ? "in selection" : "in view"}
            </Label>
            <div className="max-h-40 overflow-y-auto space-y-2">
              {selectedPeriods.map((period) => (
                <div
                  key={getPeriodId(period)}
                  className="flex items-start justify-between gap-2 rounded border p-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {period.location?.name
                        ? `${period.location.name} · `
                        : ""}
                      {period.timeZone}
                    </div>
                    <div className="text-muted-foreground">
                      {describePeriod(period)}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    aria-label={`Delete ${period.timeZone} period`}
                    disabled={saving}
                    onClick={() => {
                      void deletePeriod(getPeriodId(period)).catch(() => {
                        // The store exposes the request error in this popover.
                      });
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
