import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import type { MapRouteDisplay } from "@/stores/settingsStore";

export const GAP_DISTANCES_M = [50, 100, 200, 300, 500, 1000, 2000];
export const GAP_MINUTES = [1, 2, 5, 10, 30];

const selectClass =
  "h-8 rounded-md border border-input bg-background px-2 font-medium text-foreground";

export function MapDisplaySettings({
  gapDistanceM,
  gapMinutes,
  routeOpacity,
  gapOpacity,
  showGaps,
  onToggleGaps,
  onChange,
}: MapRouteDisplay & {
  showGaps: boolean;
  onToggleGaps: () => void;
  onChange: (patch: Partial<MapRouteDisplay>) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto h-8 gap-2"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" /> Map settings
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label="Map settings"
        align="end"
        side="top"
        className="grid max-h-[var(--radix-popover-content-available-height)] w-72 max-w-[calc(100vw-1rem)] gap-4 overflow-y-auto"
      >
        <div className="grid gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={showGaps}
              onChange={onToggleGaps}
              className="accent-primary"
            />
            Show recording gaps
          </label>
          <p className="text-xs text-muted-foreground">
            Split the route when consecutive GPS points exceed either limit.
          </p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <label className="grid gap-1">
              <span>Distance limit</span>
              <select
                aria-label="Gap distance threshold"
                className={selectClass}
                value={gapDistanceM}
                onChange={(e) =>
                  onChange({ gapDistanceM: Number(e.target.value) })}
              >
                {GAP_DISTANCES_M.map((value) => (
                  <option key={value} value={value}>{value} m</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1">
              <span>Time limit</span>
              <select
                aria-label="Gap time threshold"
                className={selectClass}
                value={gapMinutes}
                onChange={(e) =>
                  onChange({ gapMinutes: Number(e.target.value) })}
              >
                {GAP_MINUTES.map((value) => (
                  <option key={value} value={value}>{value} min</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <fieldset className="grid gap-3 border-t pt-3">
          <legend className="sr-only">Opacity</legend>
          <div className="grid gap-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Route opacity</span>
              <span>{routeOpacity}%</span>
            </div>
            <Slider
              value={[routeOpacity]}
              min={5}
              max={100}
              step={1}
              thumbLabels={["Recorded route opacity"]}
              thumbValueTexts={[`${routeOpacity}%`]}
              onValueChange={([value]) => onChange({ routeOpacity: value })}
            />
          </div>
          <div className="grid gap-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Gap opacity</span>
              <span>{gapOpacity}%</span>
            </div>
            <Slider
              value={[gapOpacity]}
              min={5}
              max={100}
              step={1}
              thumbLabels={["Recording gap opacity"]}
              thumbValueTexts={[`${gapOpacity}%`]}
              onValueChange={([value]) => onChange({ gapOpacity: value })}
            />
          </div>
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}
