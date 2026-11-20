import { useEffect, useState } from "react";
import { locationProviderLabel } from "@myceliasdk/location-sources.ts";
import { LocationProviderSelect } from "./LocationProviderSelect";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Crosshair, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  useDeleteLocationImport,
  useLocationImports,
  useLocationImportSources,
  useUpdateLocationImportSource,
} from "@/hooks/useLocationQueries";
import type { LocationImport } from "@/types/location";
import { useActionDialog } from "@/components/ActionDialogProvider";

interface ImportsListProps {
  enabled?: boolean;
  /** Fly the map (or navigate) to the import's time range. */
  onShowOnMap?: (imp: LocationImport) => void;
  emptyText?: string;
  manageSources?: boolean;
}

function formatBytes(value: number | undefined): string {
  if (!value) return "unknown size";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit++;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function ImportsList({
  enabled = true,
  onShowOnMap,
  emptyText = "No tracks imported yet.",
  manageSources = false,
}: ImportsListProps) {
  const [filename, setFilename] = useState("");
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("");
  const [sort, setSort] = useState<"recent" | "source">("recent");
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<string>();
  const { data: imports, isLoading, isError } = useLocationImports(enabled, manageSources
    ? { search, provider: provider || undefined, sort, skip: page * 100 }
    : undefined);
  const { data: sources } = useLocationImportSources(enabled && manageSources);
  const updateSource = useUpdateLocationImportSource();
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(filename.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [filename]);
  const deleteImport = useDeleteLocationImport();
  const { confirmAction } = useActionDialog();
  const number = new Intl.NumberFormat();

  const handleDelete = async (imp: LocationImport) => {
    const ok = await confirmAction({
      title: `Delete import "${imp.filename}"?`,
      description:
        "This source file and its metadata links will be removed. GPS points shared with another import will be kept.",
      actionLabel: "Delete import",
      destructive: true,
    });
    if (!ok) return;
    try {
      const result = await deleteImport.mutateAsync(String(imp._id));
      toast.success(
        `Import deleted (${
          number.format(result?.deletedPoints ?? 0)
        } source-only points removed).`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const groups = [...(sources ?? [])].sort((a, b) =>
    locationProviderLabel(a.provider).localeCompare(locationProviderLabel(b.provider))
  );
  const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";

  return (
    <div className="space-y-2">
      {manageSources && (
        <div className="flex flex-wrap items-center gap-2">
          <Input className="w-full sm:w-48" placeholder="Find by filename…" aria-label="Find imports by filename"
            value={filename} onChange={(event) => setFilename(event.target.value)} />
          <select className={selectClass} aria-label="Filter by source application" value={provider}
            onChange={(event) => {
              setProvider(event.target.value);
              setPage(0);
            }}>
            <option value="">All applications</option>
            {groups.map(({ provider, count }) => (
              <option value={provider} key={provider}>{locationProviderLabel(provider)} ({count})</option>
            ))}
          </select>
          <select className={selectClass} aria-label="Sort imports" value={sort}
            onChange={(event) => {
              setSort(event.target.value === "source" ? "source" : "recent");
              setPage(0);
            }}>
            <option value="recent">Newest first</option>
            <option value="source">Application, then filename</option>
          </select>
        </div>
      )}
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {isError && <p role="alert" className="text-sm text-destructive">Could not load imports.</p>}
      {!isLoading && !isError && !imports?.length && (
        <p className="text-sm text-muted-foreground">
          {provider || search ? "No matching imports." : emptyText}
        </p>
      )}
      {(imports ?? []).map((imp) => (
        <div
          key={String(imp._id)}
          className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{imp.filename}</span>
              <Badge variant="secondary" className="uppercase">
                {imp.format}
              </Badge>
              {imp.status !== "processed" && (
                <Badge
                  variant={imp.status === "failed" || imp.status === "error"
                    ? "destructive"
                    : "outline"}
                >
                  {imp.status === "parsed" ? "processing" : imp.status}
                </Badge>
              )}
            </div>
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{locationProviderLabel(imp.origin?.provider)}</span>
              {manageSources && imp.committedAt && (editing === String(imp._id)
                ? (
                  <LocationProviderSelect
                    provider={imp.origin?.provider}
                    label={`Source application for ${imp.filename}`}
                    disabled={updateSource.isPending}
                    onChange={(provider) => {
                      updateSource.mutate({ id: String(imp._id), provider }, {
                        onSuccess: () => setEditing(undefined),
                        onError: (error) => toast.error(error.message),
                      });
                    }}
                  />
                )
                : <Button variant="ghost" size="sm" className="h-6 px-2 text-xs"
                    aria-label={`Edit source for ${imp.filename}`}
                    onClick={() => setEditing(String(imp._id))}>Edit source</Button>)}
            </div>
            <div className="text-xs text-muted-foreground">
              {imp.receipt
                ? (
                  <>
                    {number.format(imp.receipt.newPoints ?? imp.pointCount)} new
                    {imp.receipt.matchedPoints > 0 &&
                      ` · ${number.format(imp.receipt.matchedPoints)} linked`}
                    {imp.receipt.tracks > 0 &&
                      ` · ${number.format(imp.receipt.tracks)} tracks`}
                    {imp.receipt.bookmarks > 0 &&
                      ` · ${number.format(imp.receipt.bookmarks)} places`}
                    {imp.receipt.conflictGroups > 0 &&
                      ` · ${number.format(imp.receipt.conflictGroups)} review`}
                  </>
                )
                : (
                  <>
                    {number.format(imp.pointCount)} pts
                    {(imp.dedupedCount ?? 0) > 0 &&
                      ` · ${number.format(imp.dedupedCount ?? 0)} linked`}
                    {imp.skippedCount > 0 &&
                      ` · ${number.format(imp.skippedCount)} skipped`}
                  </>
                )}
              {imp.timeRange?.start && (
                <>
                  {" · "}
                  {new Date(imp.timeRange.start).toLocaleDateString()} —{" "}
                  {new Date(imp.timeRange.end).toLocaleDateString()}
                </>
              )}
            </div>
            {imp.receipt && (
              <details className="mt-1 text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none font-medium text-foreground/80">
                  File details
                </summary>
                <div className="mt-2 grid gap-2 rounded bg-muted/50 p-2 sm:grid-cols-2">
                  <div>
                    <p className="font-medium text-foreground">Source</p>
                    <p>
                      {formatBytes(
                        imp.receipt.file?.sizeBytes ?? imp.fileSize,
                      )} · parser v{imp.receipt.file?.parserVersion ?? "legacy"}
                    </p>
                    {(imp.receipt.file?.sourceEntryName ??
                      imp.sourceEntryName) && (
                      <p>
                        KML entry: {imp.receipt.file?.sourceEntryName ??
                          imp.sourceEntryName}
                      </p>
                    )}
                    {imp.receipt.file?.contentHash && (
                      <p
                        className="font-mono"
                        title={imp.receipt.file.contentHash}
                      >
                        SHA-256 {imp.receipt.file.contentHash.slice(0, 16)}…
                      </p>
                    )}
                    {imp.geometryCompleteness === "render-only" && (
                      <p className="text-amber-600">
                        Full geometry still needs source backfill.
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="font-medium text-foreground">Content</p>
                    <p>
                      {number.format(imp.receipt.timedCoordinates ?? 0)} timed ·
                      {" "}
                      {number.format(imp.receipt.untimedCoordinates ?? 0)}{" "}
                      untimed coordinates
                    </p>
                    <p>
                      {number.format(imp.receipt.timedTracks ?? 0)} timed ·{" "}
                      {number.format(imp.receipt.untimedTracks ?? 0)} untimed ·
                      {" "}
                      {number.format(imp.receipt.mixedTracks ?? 0)} mixed tracks
                    </p>
                    <p>
                      {number.format(imp.receipt.bookmarks ?? 0)} saved places ·
                      {" "}
                      {number.format(imp.receipt.styleDefinitions ?? 0)} styles
                    </p>
                  </div>
                  <div>
                    <p className="font-medium text-foreground">Deduplication</p>
                    <p>
                      {number.format(imp.receipt.sourcePoints ?? 0)} source ·
                      {" "}
                      {number.format(imp.receipt.uniquePoints ?? 0)} unique
                    </p>
                    <p>
                      {number.format(imp.receipt.newPoints ?? 0)} new ·{" "}
                      {number.format(imp.receipt.matchedPoints ?? 0)} existing ·
                      {" "}
                      {number.format(imp.receipt.withinFileDuplicates ?? 0)}
                      {" "}
                      repeated points
                    </p>
                    <p>
                      {number.format(
                        imp.receipt.withinFileTrackDuplicates ?? 0,
                      )} repeated tracks · {number.format(
                        imp.receipt.withinFileBookmarkDuplicates ?? 0,
                      )} repeated saved places
                    </p>
                    {(imp.receipt.conflictGroups ?? 0) > 0 && (
                      <p className="text-amber-600">
                        {number.format(imp.receipt.conflictGroups)}{" "}
                        coordinate conflicts
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="font-medium text-foreground">Quality</p>
                    <p>
                      {number.format(imp.receipt.invalidCoordinates ?? 0)}{" "}
                      invalid coordinates ·{" "}
                      {number.format(imp.receipt.invalidTimestamps ?? 0)}{" "}
                      invalid times
                    </p>
                    <p>
                      {number.format(imp.receipt.unpairedCoordinates ?? 0)}{" "}
                      coordinates without time ·{" "}
                      {number.format(imp.receipt.unpairedTimestamps ?? 0)}{" "}
                      times without coordinates
                    </p>
                    {(imp.receipt.unsupportedGeometries ?? 0) > 0 && (
                      <p>
                        {number.format(imp.receipt.unsupportedGeometries)}{" "}
                        unsupported geometries retained in source
                      </p>
                    )}
                  </div>
                </div>
                {(imp.datasetMetadata || imp.contentProfile?.datasetMetadata) &&
                  (
                    <details className="mt-1 rounded bg-muted/40 p-2">
                      <summary className="cursor-pointer font-medium text-foreground/80">
                        Dataset metadata
                      </summary>
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">
                      {JSON.stringify(
                        imp.contentProfile?.datasetMetadata ??
                          imp.datasetMetadata,
                        null,
                        2,
                      )}
                      </pre>
                    </details>
                  )}
              </details>
            )}
          </div>
          <div className="flex shrink-0 gap-0.5">
            {onShowOnMap && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="Show this period on the map"
                aria-label={`Show ${imp.filename} period on the map`}
                onClick={() => onShowOnMap(imp)}
              >
                <Crosshair className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              title="Delete import and its points"
              aria-label={`Delete import ${imp.filename}`}
              onClick={() => handleDelete(imp)}
              disabled={deleteImport.isPending}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ))}
      {manageSources && (page > 0 || imports?.length === 100) && (
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" disabled={page === 0}
            onClick={() => setPage((current) => current - 1)}>Previous</Button>
          <span className="text-xs text-muted-foreground">Page {page + 1}</span>
          <Button variant="outline" size="sm" disabled={imports?.length !== 100}
            onClick={() => setPage((current) => current + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}
