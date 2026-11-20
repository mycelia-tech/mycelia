import { useState } from "react";
import {
  ArrowLeft,
  Check,
  GitCompareArrows,
  Loader2,
  Undo2,
} from "lucide-react";
import { CircleMarker, Polyline } from "react-leaflet";
import { LocationMap } from "@/components/location/LocationMap";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LOCATION_REVIEW_PAGE_SIZE,
  type LocationReviewDecision,
  type LocationReviewStatus,
  useLocationConflicts,
  useLocationMetadataConflicts,
  useLocationReviewDecisions,
  useLocationRouteConflictPreview,
  useLocationRouteConflicts,
} from "@/hooks/useLocationQueries";
import type {
  LocationMetadataConflict,
  LocationPointConflict,
  LocationRouteConflict,
} from "@/types/location";

type ReviewItem =
  | { kind: "route"; conflict: LocationRouteConflict }
  | { kind: "point"; conflict: LocationPointConflict }
  | { kind: "metadata"; conflict: LocationMetadataConflict };
type MetadataChoice = "keep_existing" | "use_incoming";

const reviewTabs = [
  { status: "pending", label: "To review", empty: "Nothing needs review." },
  { status: "deferred", label: "Later", empty: "No deferred items." },
  { status: "resolved", label: "Applied", empty: "No saved decisions." },
] as const;

const blue = "#2563eb";
const violet = "#9333ea";
const metadataChoices = [
  { resolution: "keep_existing", label: "Keep current" },
  { resolution: "use_incoming", label: "Use incoming" },
] as const;

function itemId(item: ReviewItem) {
  return String(item.conflict._id);
}

function dateTime(value: Date | string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function routeOptions(route: LocationRouteConflict) {
  const firstImportedAt = route.sources?.[0]?.importedAt;
  const secondImportedAt = route.sources?.[1]?.importedAt;
  const first = firstImportedAt ? new Date(firstImportedAt).getTime() : NaN;
  const second = secondImportedAt ? new Date(secondImportedAt).getTime() : NaN;
  const ordered = Number.isFinite(first) && Number.isFinite(second) &&
    first !== second;
  const order = ordered && first > second ? [1, 0] : [0, 1];
  return order.map((index, position) => {
    const source = route.sources?.[index];
    return {
      id: String(route.trackIds[index]),
      resolution: index === 0 ? "use_first" as const : "use_second" as const,
      label: ordered
        ? position === 0 ? "Existing route" : "Incoming route"
        : position === 0
        ? "Route A"
        : "Route B",
      color: position === 0 ? blue : violet,
      filename: source?.filename,
      format: source?.format,
      importedAt: source?.importedAt,
      title: source?.name || route.trackNames[index] || source?.filename ||
        "Untitled route",
    };
  });
}

function itemTitle(item: ReviewItem) {
  switch (item.kind) {
    case "route":
      return routeOptions(item.conflict).map(({ title }) => title).join(" · ");
    case "point":
      return dateTime(item.conflict.ts);
    case "metadata":
      return `${
        {
          track: "Track",
          bookmark: "Place",
          point: "Point",
        }[item.conflict.entityType]
      } ${
        item.conflict.field.replace(
          /[A-Z]/g,
          (char) => ` ${char.toLowerCase()}`,
        )
      }`;
  }
}

function savedDecision(item: ReviewItem) {
  if (item.kind === "route") {
    const { resolution } = item.conflict;
    if (resolution === "keep_both") return "Both sources kept";
    const selected = routeOptions(item.conflict).find((option) =>
      option.resolution === resolution
    );
    if (selected) return `Using ${selected.title}`;
  }
  if (item.conflict.resolution === "keep_existing") return "Current kept";
  if (item.conflict.resolution === "use_incoming") return "Incoming applied";
  return "Decision saved";
}

function moveDecision(
  item: ReviewItem,
  resolution: "defer" | "resume",
): LocationReviewDecision {
  const action = item.kind === "route"
    ? "resolve-route-conflict"
    : item.kind === "metadata"
    ? "resolve-metadata-conflict"
    : "resolve-conflict";
  return { action, id: itemId(item), resolution };
}

function ValueColumn(
  { label, value, selected, note, detail, color, onSelect }: {
    label: string;
    value: unknown;
    selected?: boolean;
    note?: string;
    detail?: string;
    color?: string;
    onSelect?: () => void;
  },
) {
  const className = `min-w-0 w-full rounded-md border p-2.5 text-left ${
    selected ? "border-blue-500 bg-blue-500/10" : "bg-muted/30"
  }`;
  const content = (
    <>
      <span className="mb-1 flex min-h-4 items-center gap-2 text-xs font-medium text-muted-foreground">
        {color && (
          <span
            aria-hidden="true"
            className="h-1 w-4 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        <span className="flex-1">{label}</span>
        {onSelect && (
          <span
            aria-hidden="true"
            className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
              selected
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-muted-foreground/50"
            }`}
          >
            {selected && <Check className="h-3 w-3" />}
          </span>
        )}
      </span>
      <span className="block max-h-36 overflow-auto whitespace-pre-wrap break-words text-sm font-medium">
        {typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2) ?? "No value"}
      </span>
      {detail && (
        <span className="mt-1 block break-words text-xs text-muted-foreground">
          {detail}
        </span>
      )}
      {note && (
        <span className="mt-1 block text-xs text-muted-foreground">{note}</span>
      )}
    </>
  );
  return onSelect
    ? (
      <button
        type="button"
        aria-pressed={!!selected}
        className={`${className} self-stretch hover:border-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
        onClick={onSelect}
      >
        {content}
      </button>
    )
    : <div className={className}>{content}</div>;
}

function MetadataComparison(
  { conflict, resolution, expanded, pending, onChoose }: {
    conflict: LocationMetadataConflict;
    resolution?: LocationReviewDecision["resolution"];
    expanded: boolean;
    pending: boolean;
    onChoose?: (choice: MetadataChoice) => void;
  },
) {
  return (
    <div
      className="grid grid-cols-2 gap-2"
      role="group"
      aria-label="Compare metadata values"
    >
      <ValueColumn
        label="Current at import"
        value={conflict.existingValue}
        selected={resolution === "keep_existing"}
        note={expanded && pending && conflict.defaultSelection === "existing"
          ? "Used by default"
          : undefined}
        onSelect={onChoose && (() => onChoose("keep_existing"))}
      />
      <ValueColumn
        label={`Incoming · ${conflict.incomingFormat.toUpperCase()}`}
        value={conflict.incomingValue}
        selected={resolution === "use_incoming"}
        note={expanded && pending && conflict.defaultSelection === "incoming"
          ? "Used by default"
          : undefined}
        onSelect={onChoose && (() => onChoose("use_incoming"))}
      />
    </div>
  );
}

type RouteChoice = "use_first" | "use_second" | "keep_both";

function RouteComparison(
  { conflict, gapDistanceM, gapMinutes, resolution, onChoose }: {
    conflict: LocationRouteConflict;
    gapDistanceM: number;
    gapMinutes: number;
    resolution?: LocationReviewDecision["resolution"];
    onChoose?: (choice: RouteChoice) => void;
  },
) {
  const preview = useLocationRouteConflictPreview(
    String(conflict._id),
    gapDistanceM,
    gapMinutes,
  );
  const paths = preview.data?.fragments ?? [];
  const points = paths.flatMap(({ path }) =>
    path.map(([lng, lat]): [number, number] => [lat, lng])
  );
  const sourceCount = new Set(paths.map(({ trackId }) => String(trackId))).size;
  const options = routeOptions(conflict);
  return (
    <div className="space-y-2">
      <div
        className="grid grid-cols-2 gap-2"
        role="group"
        aria-label="Compare route sources"
      >
        {options.map((option) => (
          <ValueColumn
            key={option.id}
            label={option.label}
            value={option.title}
            color={option.color}
            detail={option.filename !== option.title
              ? option.filename
              : option.format?.toUpperCase()}
            note={option.importedAt
              ? `Imported ${dateTime(option.importedAt)}`
              : undefined}
            selected={resolution === option.resolution ||
              resolution === "keep_both"}
            onSelect={onChoose && (() => onChoose(option.resolution))}
          />
        ))}
      </div>
      {onChoose && (
        <Button
          type="button"
          size="sm"
          variant={resolution === "keep_both" ? "secondary" : "outline"}
          aria-pressed={resolution === "keep_both"}
          onClick={() => onChoose("keep_both")}
        >
          {resolution === "keep_both" && <Check className="h-3.5 w-3.5" />}
          Keep both routes
        </Button>
      )}
      {points.length > 0 && (
        <div
          className="isolate h-52 overflow-hidden rounded-md border"
          role="region"
          aria-label="Route source comparison"
        >
          <LocationMap
            segments={[]}
            extraBoundsPoints={points}
            scrollWheelZoom={false}
          >
            {paths.map(({ id, trackId, path }) => {
              const option = options.find(({ id }) => id === String(trackId));
              const highlighted = !resolution || resolution === "keep_both" ||
                resolution === option?.resolution;
              return (
                <Polyline
                  key={id}
                  positions={path.map(([lng, lat]) => [lat, lng])}
                  pathOptions={{
                    color: option?.color,
                    weight: 4,
                    opacity: highlighted ? 0.9 : 0.22,
                  }}
                />
              );
            })}
          </LocationMap>
        </div>
      )}
      {preview.isLoading && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading both routes…
        </p>
      )}
      {preview.isError && (
        <p role="alert" className="text-xs text-destructive">
          Could not load the route preview.
        </p>
      )}
      {preview.data && sourceCount < 2 && (
        <p className="text-xs text-muted-foreground">
          Some route geometry is unavailable in this period.
        </p>
      )}
      {preview.data?.detailLimited && (
        <p className="text-xs text-muted-foreground">
          Preview shows a subset of the route geometry.
        </p>
      )}
    </div>
  );
}

function PointComparison({ conflict, candidateIndex }: {
  conflict: LocationPointConflict;
  candidateIndex: number;
}) {
  const existing = conflict.existingPoints ?? [];
  const incoming = conflict.candidates?.[candidateIndex]?.points ?? [];
  const groups = [existing, incoming];
  const points = groups.flatMap((group) =>
    group.map((
      { loc: { coordinates: [lng, lat] } },
    ): [number, number] => [lat, lng])
  );
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {groups.map((group, index) => (
          <ValueColumn
            key={index}
            label={index === 0 ? "Current · blue" : "Incoming · purple"}
            value={group.map(({ loc: { coordinates: [lng, lat] }, ele }) =>
              `${lat.toFixed(6)}, ${lng.toFixed(6)}${
                ele === undefined ? "" : ` · ${ele} m`
              }`
            ).join("\n") || "No points"}
          />
        ))}
      </div>
      {points.length > 0 && (
        <div
          className="isolate h-48 overflow-hidden rounded-md border"
          role="region"
          aria-label="Coordinate comparison"
        >
          <LocationMap
            segments={[]}
            extraBoundsPoints={points}
            scrollWheelZoom={false}
            fitRequestKey={candidateIndex}
          >
            {groups.map((group, index) =>
              group.map(({ hash, loc: { coordinates: [lng, lat] } }) => (
                <CircleMarker
                  key={`${index}:${hash}`}
                  center={[lat, lng]}
                  radius={6}
                  pathOptions={{
                    color: index === 0 ? blue : violet,
                    fillOpacity: 0.65,
                  }}
                />
              ))
            )}
          </LocationMap>
        </div>
      )}
    </div>
  );
}

function ReviewCard({ item, status, busy, gapDistanceM, gapMinutes, onSave }: {
  item: ReviewItem;
  status: LocationReviewStatus;
  busy: boolean;
  gapDistanceM: number;
  gapMinutes: number;
  onSave: (decisions: LocationReviewDecision[]) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [choice, setChoice] = useState<LocationReviewDecision>();
  const [candidateIndex, setCandidateIndex] = useState(() =>
    item.kind === "point" && item.conflict.selectedImportId
      ? Math.max(
        0,
        item.conflict.candidates?.findIndex(
          (candidate) =>
            String(candidate.importId) ===
              String(item.conflict.selectedImportId),
        ) ?? 0,
      )
      : 0
  );
  const id = itemId(item);
  const decidedAt = item.kind === "route"
    ? item.conflict.resolvedAt
    : item.conflict.decidedAt;
  const candidate = item.kind === "point"
    ? item.conflict.candidates?.[candidateIndex]
    : undefined;
  const resolution = choice?.resolution ??
    (status === "resolved" ? item.conflict.resolution : undefined);
  const chooseMetadata = (value: MetadataChoice) => {
    setChoice(
      item.kind === "metadata"
        ? { action: "resolve-metadata-conflict", id, resolution: value }
        : {
          action: "resolve-conflict",
          id,
          resolution: value,
          candidateImportId: value === "use_incoming" && candidate
            ? String(candidate.importId)
            : undefined,
        },
    );
  };
  const canUndo = item.kind === "route" && status === "resolved" &&
    item.conflict.resolvedAt;
  const canChoose = status === "pending" && expanded && !busy;
  return (
    <section className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="break-words font-medium">{itemTitle(item)}</h4>
          {item.kind === "route" && (
            <p className="mt-1 text-xs text-muted-foreground">
              {dateTime(item.conflict.overlapStart)} –{" "}
              {dateTime(item.conflict.overlapEnd)} ·{" "}
              {Math.round(item.conflict.medianSeparationM / 1000)} km apart
            </p>
          )}
          {status === "resolved" && (
            <p className="mt-1 text-xs text-muted-foreground">
              {savedDecision(item)}
              {decidedAt && ` · ${dateTime(decidedAt)}`}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          aria-expanded={expanded}
          aria-label={expanded ? "Close comparison" : undefined}
          onClick={() => {
            setExpanded(!expanded);
            setChoice(undefined);
          }}
        >
          <GitCompareArrows className="h-3.5 w-3.5" />
          {expanded ? "Close" : "Compare"}
        </Button>
      </div>
      {item.kind === "metadata" && (
        <MetadataComparison
          conflict={item.conflict}
          resolution={resolution}
          expanded={expanded}
          pending={status === "pending"}
          onChoose={canChoose ? chooseMetadata : undefined}
        />
      )}
      {expanded && item.kind !== "metadata" && (
        <div className="space-y-3 pt-1">
          {item.kind === "route" && (
            <RouteComparison
              conflict={item.conflict}
              gapDistanceM={gapDistanceM}
              gapMinutes={gapMinutes}
              resolution={resolution}
              onChoose={canChoose
                ? (value) =>
                  setChoice({
                    action: "resolve-route-conflict",
                    id,
                    resolution: value,
                  })
                : undefined}
            />
          )}
          {item.kind === "point" && (
            <>
              {status !== "resolved" &&
                (item.conflict.candidates?.length ?? 0) > 1 && (
                <label className="flex items-center gap-2 text-xs">
                  Incoming source
                  <select
                    className="rounded-md border bg-background p-1.5"
                    value={candidateIndex}
                    onChange={(event) => {
                      setCandidateIndex(Number(event.target.value));
                      setChoice(undefined);
                    }}
                  >
                    {item.conflict.candidates?.map((source, index) => (
                      <option key={String(source.importId)} value={index}>
                        {source.format.toUpperCase()} · source {index + 1}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <PointComparison
                conflict={item.conflict}
                candidateIndex={candidateIndex}
              />
            </>
          )}
          {status === "pending" && item.kind === "point" && (
            <div
              className="grid grid-cols-2 gap-2"
              role="group"
              aria-label="Choose what to apply"
            >
              {metadataChoices.map(({ resolution, label }) => (
                <Button
                  key={resolution}
                  size="sm"
                  variant={choice?.resolution === resolution
                    ? "secondary"
                    : "outline"}
                  aria-pressed={choice?.resolution === resolution}
                  disabled={busy ||
                    (resolution === "use_incoming" && !candidate)}
                  onClick={() => chooseMetadata(resolution)}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
      {(status !== "resolved" || (expanded && canUndo)) && (
        <div className="flex items-center justify-between gap-2 pt-1">
          {status !== "resolved" && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                void onSave([
                  moveDecision(
                    item,
                    status === "deferred" ? "resume" : "defer",
                  ),
                ])}
            >
              {status === "deferred" ? "Back to review" : "Decide later"}
            </Button>
          )}
          {expanded && status === "pending" && (
            <Button
              size="sm"
              disabled={busy || !choice}
              onClick={() => choice && void onSave([choice])}
            >
              Apply decision
            </Button>
          )}
          {expanded && canUndo && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={busy}
              onClick={() =>
                void onSave([{
                  action: "resolve-route-conflict",
                  id,
                  resolution: "undo",
                  expectedResolvedAt: item.conflict.resolvedAt,
                }])}
            >
              <Undo2 className="h-3.5 w-3.5" />Undo route decision
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function LocationConflictReviewDialog(
  { open, onOpenChange, gapDistanceM, gapMinutes }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    gapDistanceM: number;
    gapMinutes: number;
  },
) {
  const [status, setStatus] = useState<LocationReviewStatus>("pending");
  const [page, setPage] = useState(0);
  const [bulk, setBulk] = useState<{ choice: MetadataChoice; ids: string[] }>();
  const [feedback, setFeedback] = useState<{ text: string; error: boolean }>();
  const skip = page * LOCATION_REVIEW_PAGE_SIZE;
  const points = useLocationConflicts(status, open, skip);
  const metadata = useLocationMetadataConflicts(status, open, skip);
  const routes = useLocationRouteConflicts(status, open, skip);
  const decisions = useLocationReviewDecisions();
  const groups: Array<{ title: string; items: ReviewItem[]; total: number }> = [
    {
      title: "Overlapping routes",
      items: (routes.data?.conflicts ?? []).map((conflict) => ({
        kind: "route",
        conflict,
      })),
      total: routes.data?.total ?? 0,
    },
    {
      title: "Metadata differences",
      items: (metadata.data?.conflicts ?? []).map((conflict) => ({
        kind: "metadata",
        conflict,
      })),
      total: metadata.data?.total ?? 0,
    },
    {
      title: "Coordinate differences",
      items: (points.data?.conflicts ?? []).map((conflict) => ({
        kind: "point",
        conflict,
      })),
      total: points.data?.total ?? 0,
    },
  ];
  const maxTotal = Math.max(...groups.map(({ total }) => total));
  const busy = decisions.isPending;
  const loading = points.isLoading || metadata.isLoading || routes.isLoading;
  const loadError = points.isError || metadata.isError || routes.isError;

  async function save(items: LocationReviewDecision[]) {
    setFeedback(undefined);
    setBulk(undefined);
    const { saved, failures } = await decisions.mutateAsync(items);
    const messages = {
      defer: "Moved to Later.",
      resume: "Moved back to To review.",
      undo: "Route decision undone. Both sources are back in review.",
    };
    const resolution = items[0].resolution;
    setFeedback({
      error: failures.length > 0,
      text: failures.length
        ? `Saved ${saved} of ${items.length}. ${failures[0]}`
        : resolution === "defer" || resolution === "resume" ||
            resolution === "undo"
        ? messages[resolution]
        : `Applied ${saved} ${
          saved === 1 ? "decision" : "decisions"
        }. See Applied for details.`,
    });
  }

  function changePage(next: number) {
    setPage(next);
    setBulk(undefined);
    setFeedback(undefined);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) {
          setBulk(undefined);
          setFeedback(undefined);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[90dvh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="px-4 pb-3 pt-5 pr-10 sm:px-6">
          <DialogTitle>Review location differences</DialogTitle>
          <DialogDescription>
            Compare imported values and routes before applying a decision.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={status}
          onValueChange={(value) => {
            setStatus(value as LocationReviewStatus);
            changePage(0);
          }}
          className="flex min-h-0 flex-col"
        >
          <div className="space-y-2 border-b px-4 pb-3 sm:px-6">
            <TabsList aria-label="Review status">
              {reviewTabs.map(({ status, label }) => (
                <TabsTrigger key={status} value={status} disabled={busy}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
            {feedback && (
              <p
                role={feedback.error ? "alert" : "status"}
                className={feedback.error
                  ? "text-sm text-destructive"
                  : "text-sm text-muted-foreground"}
              >
                {feedback.text}
              </p>
            )}
            {busy && (
              <p
                role="status"
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Loader2 className="h-4 w-4 animate-spin" />Saving decisions…
              </p>
            )}
          </div>
          <TabsContent
            key={status}
            value={status}
            className="mt-0 space-y-4 overflow-y-auto px-4 py-4 sm:px-6"
          >
            {status === "deferred" && (
              <p className="text-sm text-muted-foreground">
                These items stay here until you move them back to review. Their
                map values stay as they were.
              </p>
            )}
            {loading && (
              <p role="status" className="text-sm text-muted-foreground">
                Loading differences…
              </p>
            )}
            {loadError && (
              <p role="alert" className="text-sm text-destructive">
                Some differences could not be loaded.
              </p>
            )}
            {!loading && !loadError && !maxTotal && (
              <p className="text-sm text-muted-foreground">
                {reviewTabs.find((tab) => tab.status === status)?.empty}
              </p>
            )}
            {groups.filter(({ items }) => items.length > 0).map(
              ({ title, items, total }) => {
                const bulkAvailable = status === "pending" &&
                  items.length > 1 && items[0].kind === "metadata";
                return (
                  <section key={title} className="space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold">
                        {title} <Badge variant="secondary">{total}</Badge>
                      </h3>
                      {bulkAvailable && !bulk && (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              setBulk({
                                choice: "keep_existing",
                                ids: items.map(itemId),
                              })}
                          >
                            Keep current for {items.length}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              setBulk({
                                choice: "use_incoming",
                                ids: items.map(itemId),
                              })}
                          >
                            Use incoming for {items.length}
                          </Button>
                        </div>
                      )}
                    </div>
                    {bulk && bulkAvailable && (
                      <div className="space-y-2 rounded-md border border-blue-500/40 bg-blue-500/5 p-3 text-sm">
                        <p>
                          {bulk.choice === "keep_existing"
                            ? "Keep the current values"
                            : "Use the incoming values"} for these{" "}
                          {bulk.ids.length} metadata differences?
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setBulk(undefined)}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            disabled={busy || !bulk.ids.every((id) =>
                              items.some((item) => itemId(item) === id)
                            )}
                            onClick={() =>
                              void save(
                                bulk.ids.map((id) => ({
                                  action: "resolve-metadata-conflict",
                                  id,
                                  resolution: bulk.choice,
                                })),
                              )}
                          >
                            Apply {bulk.ids.length} decisions
                          </Button>
                        </div>
                      </div>
                    )}
                    {items.map((item) => (
                      <ReviewCard
                        key={itemId(item)}
                        item={item}
                        status={status}
                        busy={busy || !!bulk}
                        gapDistanceM={gapDistanceM}
                        gapMinutes={gapMinutes}
                        onSave={save}
                      />
                    ))}
                  </section>
                );
              },
            )}
            {(page > 0 || maxTotal > (page + 1) * LOCATION_REVIEW_PAGE_SIZE) &&
              (
                <div className="flex items-center justify-between gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || page === 0}
                    onClick={() => changePage(page - 1)}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Page {page + 1}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy ||
                      maxTotal <= (page + 1) * LOCATION_REVIEW_PAGE_SIZE}
                    onClick={() => changePage(page + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
