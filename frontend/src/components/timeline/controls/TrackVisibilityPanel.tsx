import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Layers, Eye, EyeOff, LayoutGrid, LayoutList, X } from "lucide-react";
import { useTrackVisibilityStore } from "@/stores/trackVisibilityStore";
import { useTrackPanelStore } from "@/stores/trackPanelStore";
import { TRACK_REGISTRY } from "@/components/timeline/tracks";
import { OBJECT_CATEGORIES } from "@/types/tracks";
import { useObjectCategoryCounts, useTotalObjectCount } from "@/modules/objects/useObjects";
import { useHistogramCounts } from "@/modules/histogram/useHistogramCounts";

// Button to toggle the side panel
export function TrackVisibilityButton() {
  const { isOpen, toggle } = useTrackPanelStore();

  return (
    <Button
      variant={isOpen ? "secondary" : "outline"}
      size="sm"
      aria-expanded={isOpen}
      aria-controls="timeline-track-panel"
      title="Track visibility"
      onClick={toggle}
    >
      <Layers className="h-4 w-4" /> Tracks
    </Button>
  );
}

// Side panel content
export function TrackVisibilityPanel() {
  const {
    visibleTracks,
    toggleTrack,
    showAll,
    hideAll,
    objectsLayoutMode,
    setObjectsLayoutMode,
    visibleObjectCategories,
    toggleObjectCategory,
  } = useTrackVisibilityStore();

  const { isOpen, setOpen } = useTrackPanelStore();
  const categoryCounts = useObjectCategoryCounts();
  const totalObjectCount = useTotalObjectCount();
  const histogramCounts = useHistogramCounts();

  if (!isOpen) return null;

  // Map track IDs to their counts
  const getTrackCount = (trackId: string): number | undefined => {
    switch (trackId) {
      case "voice-detection":
        return histogramCounts.voiceDetection;
      case "data-presence":
        return histogramCounts.dataPresence;
      case "transcriptions":
        return histogramCounts.transcriptions;
      case "audio-chunks":
        return histogramCounts.audioChunks;
      // Speaker identity reads active speaker segments directly. It is not a
      // histogram-derived track and intentionally has no density count here.
      case "diarizations":
        return undefined;
      case "objects":
        return totalObjectCount;
      default:
        return undefined;
    }
  };

  // Include objects track in the list
  const allTracks = [
    ...TRACK_REGISTRY,
    {
      config: {
        id: "objects" as const,
        label: "Objects",
        description: "Timeline objects and events",
        defaultVisible: true,
        defaultHeight: 120,
        color: "#6b7280",
      },
    },
  ];

  const showObjectsOptions = visibleTracks.includes("objects");

  return (
    <aside id="timeline-track-panel" aria-label="Track visibility" className="flex max-h-[55dvh] flex-col rounded-lg border bg-card lg:col-start-2 lg:row-start-2 lg:row-span-2 lg:max-h-[var(--workspace-panel-height)]">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <h4 className="font-semibold text-base">Visible Tracks</h4>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={showAll}
            className="h-8 px-2"
            title="Show all"
          >
            <Eye className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={hideAll}
            className="h-8 px-2"
            title="Hide all"
          >
            <EyeOff className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            className="h-8 px-2"
            title="Close panel"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Track toggles */}
        <div className="space-y-2">
          {allTracks.map((track) => {
            const count = getTrackCount(track.config.id);
            return (
              <div
                key={track.config.id}
                className="flex items-center justify-between"
              >
                <Label
                  htmlFor={track.config.id}
                  className="text-sm cursor-pointer flex items-center flex-1"
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full mr-2 flex-shrink-0"
                    style={{ backgroundColor: track.config.color }}
                  />
                  <span className="truncate">{track.config.label}</span>
                  {count !== undefined && (
                    <span className="text-muted-foreground ml-auto tabular-nums text-xs">
                      {count.toLocaleString()}
                    </span>
                  )}
                </Label>
                <Switch
                  id={track.config.id}
                  checked={visibleTracks.includes(track.config.id)}
                  onCheckedChange={() => toggleTrack(track.config.id)}
                  className="ml-2"
                />
              </div>
            );
          })}
        </div>

        {/* Objects Layout Options */}
        {showObjectsOptions && (
          <div className="border-t pt-3">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-medium text-sm">Objects Layout</h4>
              <div className="flex gap-1">
                <Button
                  variant={objectsLayoutMode === "mixed" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setObjectsLayoutMode("mixed")}
                  className="h-8 px-2"
                  title="Mixed layout"
                >
                  <LayoutList className="h-3 w-3" />
                </Button>
                <Button
                  variant={objectsLayoutMode === "by-category" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setObjectsLayoutMode("by-category")}
                  className="h-8 px-2"
                  title="Group by category"
                >
                  <LayoutGrid className="h-3 w-3" />
                </Button>
              </div>
            </div>

            {/* Category toggles */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Categories</Label>
              {OBJECT_CATEGORIES.map((category) => (
                <div
                  key={category.id}
                  className="flex items-center justify-between"
                >
                  <Label
                    htmlFor={`cat-${category.id}`}
                    className="text-sm cursor-pointer flex items-center gap-1.5 flex-1"
                  >
                    <span>{category.icon}</span>
                    <span
                      className="inline-block w-2 h-2 rounded-full"
                      style={{ backgroundColor: category.color }}
                    />
                    <span className="truncate">{category.label}</span>
                    <span className="text-muted-foreground ml-auto tabular-nums">
                      {categoryCounts[category.id].toLocaleString()}
                    </span>
                  </Label>
                  <Switch
                    id={`cat-${category.id}`}
                    checked={visibleObjectCategories.includes(category.id)}
                    onCheckedChange={() => toggleObjectCategory(category.id)}
                    className="ml-2"
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
