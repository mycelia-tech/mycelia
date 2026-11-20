import {
  activeSourceFilter,
  ALL_LOCATION_SOURCES,
  LocationSourceFilter,
} from "./LocationSourceFilter";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Crosshair, Info, Pencil, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useDeleteLocationSegment,
  useGeotags,
} from "@/hooks/useLocationQueries";
import { LocationSegmentDialog } from "./LocationSegmentDialog";
import { AssignLocationDialog } from "./AssignLocationDialog";
import { formatDurationShort } from "./LocationMap";
import type { LocationSegment } from "@/types/location";
import {
  formatPlace,
  formatSources,
  placeColor,
  segmentDurationMs,
} from "@/types/location";
import { useActionDialog } from "@/components/ActionDialogProvider";

const TYPE_ICON: Record<string, string> = {
  stay: "🏠",
  move: "➡️",
  gap: "⋯",
  manual: "✍️",
};

const PAGE = 50;

interface GeotagsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  start: Date;
  end: Date;
  onShowOnMap: (segment: LocationSegment) => void;
}

export function GeotagsSheet({
  open,
  onOpenChange,
  start,
  end,
  onShowOnMap,
}: GeotagsSheetProps) {
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [pages, setPages] = useState(1);
  const [sources, setSources] = useState(ALL_LOCATION_SOURCES);
  const [details, setDetails] = useState<LocationSegment | null>(null);
  const [editSegment, setEditSegment] = useState<LocationSegment | null>(null);
  const deleteSegment = useDeleteLocationSegment();
  const { confirmAction } = useActionDialog();

  const { data, isLoading } = useGeotags(
    {
      start,
      end,
      type: typeFilter === "all" ? undefined : typeFilter,
      limit: pages * PAGE,
      sourceFilter: activeSourceFilter(sources),
    },
    open,
  );

  const segments = data?.segments ?? [];
  const total = data?.total ?? 0;

  const overlapsPresent = useMemo(
    () => segments.some((s) => (s.overlapIds?.length ?? 0) > 0),
    [segments],
  );

  const handleQuickDelete = async (segment: LocationSegment) => {
    const isManual = segment.type === "manual";
    const place = formatPlace(segment.place);
    const ok = await confirmAction({
      title: isManual
        ? `Remove manual location "${place}"?`
        : `Delete geotag "${place}"?`,
      description: isManual
        ? "The manual location will be removed."
        : "This permanently deletes its underlying GPS points. Re-importing the same file will not restore them.",
      actionLabel: isManual ? "Remove location" : "Delete geotag",
      destructive: true,
    });
    if (!ok) return;
    try {
      const result = await deleteSegment.mutateAsync(String(segment._id));
      toast.success(
        isManual
          ? "Manual location removed."
          : `Deleted (${result?.deletedPoints ?? 0} GPS points removed).`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="flex w-[26rem] flex-col sm:max-w-md"
        >
          <SheetHeader>
            <SheetTitle>Geotags</SheetTitle>
            <SheetDescription>
              {total} in the selected period
              {overlapsPresent && (
                <span className="ml-2 inline-flex items-center gap-1 text-amber-600">
                  <AlertTriangle className="h-3.5 w-3.5" /> overlaps present
                </span>
              )}
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-wrap items-center gap-2">
          <Select value={typeFilter} onValueChange={(value) => {
            setTypeFilter(value);
            setPages(1);
          }}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="stay">🏠 Stays</SelectItem>
              <SelectItem value="manual">✍️ Manual</SelectItem>
              <SelectItem value="move">➡️ Moves</SelectItem>
              <SelectItem value="gap">⋯ Gaps</SelectItem>
            </SelectContent>
          </Select>
          <LocationSourceFilter
            label="Geotag sources"
            includeManual
            filter={sources}
            onChange={(filter) => {
              setSources(filter);
              setPages(1);
            }}
          />
          </div>

          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {isLoading && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {!isLoading && segments.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No geotags in this period.
              </p>
            )}
            {segments.map((segment) => {
              const sources = formatSources(segment.sources);
              const overlapping = (segment.overlapIds?.length ?? 0) > 0;
              return (
                <div
                  key={String(segment._id)}
                  className="rounded-md border p-2 text-sm"
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: segment.type === "gap"
                          ? "#9ca3af"
                          : placeColor(
                            segment.place,
                            segment.type === "manual",
                          ),
                      }}
                    />
                    <span className="mr-1">{TYPE_ICON[segment.type]}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {segment.type === "gap"
                        ? "Assumed route"
                        : formatPlace(segment.place)}
                    </span>
                    {overlapping && (
                      <AlertTriangle
                        className="h-3.5 w-3.5 shrink-0 text-amber-500"
                        aria-label="Overlaps another geotag in time"
                      />
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {new Date(segment.start).toLocaleString()} ·{" "}
                    {formatDurationShort(segmentDurationMs(segment))}
                    {sources.length > 0 && <>· {sources.join(", ")}</>}
                  </div>
                  <div className="mt-1 flex gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      title="Show on map"
                      onClick={() => onShowOnMap(segment)}
                    >
                      <Crosshair className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      title="Details"
                      onClick={() => setDetails(segment)}
                    >
                      <Info className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      title={segment.type === "manual" ? "Edit" : "Override"}
                      onClick={() => setEditSegment(segment)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive"
                      title="Delete"
                      onClick={() => handleQuickDelete(segment)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
            {segments.length < total && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setPages((p) => p + 1)}
              >
                Load more ({segments.length}/{total})
              </Button>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <LocationSegmentDialog
        segment={details}
        open={details !== null}
        onOpenChange={(o) => !o && setDetails(null)}
      />
      {editSegment && (
        <AssignLocationDialog
          open={editSegment !== null}
          onOpenChange={(o) => !o && setEditSegment(null)}
          editSegment={editSegment}
        />
      )}
    </>
  );
}
