import { LocationProviderSelect } from "./LocationProviderSelect";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  Loader2,
  Upload,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { useTrackVisibilityStore } from "@/stores/trackVisibilityStore";
import { locationKeys, useLocationImports } from "@/hooks/useLocationQueries";
import { ImportsList } from "./ImportsList";
import type {
  LocationImport,
  LocationImportCounts,
  LocationImportPreview,
} from "@/types/location";

interface PreviewFailure {
  filename: string;
  error: { code: string; message: string };
}

interface ImportReceipt {
  importId?: string;
  duplicate?: boolean;
  status?: string;
  counts: LocationImportCounts;
}

interface ImportTracksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowImportOnMap?: (imp: LocationImport) => void;
}

const number = new Intl.NumberFormat();

function count(value: number): string {
  return number.format(value ?? 0);
}

function isFailure(
  preview: LocationImportPreview | PreviewFailure,
): preview is PreviewFailure {
  return "error" in preview;
}

function confirmLabel(preview: LocationImportPreview): string {
  if (preview.counts.newPoints > 0) {
    return `Import ${count(preview.counts.newPoints)} new points`;
  }
  if (preview.counts.bookmarks > 0 || preview.counts.tracks > 0) {
    return "Add metadata and saved places";
  }
  return "Link as an additional source";
}

export function ImportTracksDialog({
  open,
  onOpenChange,
  onShowImportOnMap,
}: ImportTracksDialogProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [previews, setPreviews] = useState<
    Array<LocationImportPreview | PreviewFailure>
  >([]);
  const [confirming, setConfirming] = useState<Set<string>>(new Set());
  const [receipts, setReceipts] = useState<Record<string, ImportReceipt>>({});
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { data: imports } = useLocationImports(open);
  const { visibleTracks, toggleTrack } = useTrackVisibilityStore();

  const analyzeFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setIsAnalyzing(true);
    setPreviews([]);
    setReceipts({});
    try {
      const formData = new FormData();
      for (const file of files) formData.append("files", file);
      const authHeaders = await api.getAuthHeaders();
      const response = await fetch(
        `${api.baseURL}/api/location/imports/analyze`,
        { method: "POST", body: formData, headers: authHeaders },
      );
      if (!response.ok) throw new Error(`Analysis failed (${response.status})`);
      const data = await response.json();
      setPreviews(data.results ?? []);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The files could not be analyzed.",
      );
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  const confirmPreview = useCallback(async (preview: LocationImportPreview) => {
    setConfirming((current) => new Set(current).add(preview.previewId));
    try {
      const authHeaders = await api.getAuthHeaders();
      const response = await fetch(
        `${api.baseURL}/api/location/imports/${preview.previewId}/confirm`,
        {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: preview.origin?.evidence === "confirmed" ? preview.origin.provider : undefined,
          }),
        },
      );
      const data = await response.json();
      if (response.status === 409 && data.preview) {
        setPreviews((current) =>
          current.map((item) =>
            !isFailure(item) && item.previewId === preview.previewId
              ? data.preview
              : item
          )
        );
        toast.info("Location data changed. Review the refreshed analysis.");
        return;
      }
      if (!response.ok) {
        throw new Error(
          data.error?.message ?? "The import could not be committed.",
        );
      }
      const receipt = data.receipt as ImportReceipt;
      setReceipts((current) => ({
        ...current,
        [preview.previewId]: receipt,
      }));
      if (receipt.counts?.newPoints > 0) {
        toast.success(
          `Imported ${count(receipt.counts.newPoints)} new location points.`,
        );
        if (!visibleTracks.includes("locations")) toggleTrack("locations");
      } else {
        toast.success("Metadata and source provenance were saved.");
      }
      const keys = ["sourceExtent", "sourcePoints", "imports", "importSources", "sourceFiles", "savedPlaces", "recordedTracks", "conflicts", "metadataConflicts"];
      if (!receipt.duplicate) {
        for (const key of keys) {
          void queryClient.invalidateQueries({ queryKey: [...locationKeys.all, key] });
        }
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The import could not be committed.",
      );
    } finally {
      setConfirming((current) => {
        const next = new Set(current);
        next.delete(preview.previewId);
        return next;
      });
    }
  }, [queryClient, toggleTrack, visibleTracks]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import GPS tracks and saved places</DialogTitle>
          <DialogDescription>
            GPX, KML and KMZ files are analyzed first. Nothing is added to your
            timeline until you review and confirm. Saved places and untimed
            routes stay separate from GPS whereabouts.
          </DialogDescription>
        </DialogHeader>

        <div
          className={`flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors ${
            dragOver ? "border-primary bg-primary/5" : "border-border"
          }`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            analyzeFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <FileUp className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Drop .gpx / .kml / .kmz files here, or
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={isAnalyzing}
            onClick={() => fileInputRef.current?.click()}
          >
            {isAnalyzing
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <Upload className="mr-2 h-4 w-4" />}
            {isAnalyzing ? "Analyzing…" : "Choose files"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".gpx,.kml,.kmz"
            multiple
            className="hidden"
            onChange={(event) => {
              analyzeFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        </div>

        <div aria-live="polite" className="space-y-3">
          {previews.map((preview) => {
            if (isFailure(preview)) {
              return (
                <div
                  key={preview.filename}
                  role="alert"
                  className="rounded-md border border-destructive/40 p-3 text-sm"
                >
                  <p className="font-medium">{preview.filename}</p>
                  <p className="text-muted-foreground">
                    {preview.error.message}
                  </p>
                </div>
              );
            }
            const receipt = receipts[preview.previewId];
            const c = receipt?.counts ?? preview.counts;
            return (
              <section
                key={preview.previewId}
                className="space-y-2 rounded-md border p-3 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-medium">{preview.filename}</p>
                  <Badge variant="secondary" className="uppercase">
                    {preview.format}
                  </Badge>
                </div>
                {preview.canConfirm && !receipt && (
                  <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    Source application
                    <LocationProviderSelect
                      label={`Source application for ${preview.filename}`}
                      provider={preview.origin?.provider}
                      disabled={confirming.has(preview.previewId)}
                      onChange={(provider) => setPreviews((current) =>
                        current.map((item) =>
                          !isFailure(item) && item.previewId === preview.previewId
                            ? { ...item, origin: { provider, evidence: "confirmed" } }
                            : item
                        )
                      )}
                    />
                    {preview.origin?.evidence === "exporter" && <span>Detected from file</span>}
                  </label>
                )}
                <p className="text-xs text-muted-foreground">
                  {(preview.fileSize / 1024 / 1024).toFixed(1)} MB · parser v
                  {preview.parserVersion}
                  {preview.sourceEntryName &&
                    ` · KML entry ${preview.sourceEntryName}`}
                </p>

                {receipt
                  ? (
                    <div className="flex items-start gap-2 text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                      <p>
                        Added {count(c.newPoints)} new · linked{" "}
                        {count(c.matchedPoints)}
                        {c.tracks > 0 && ` · ${count(c.tracks)} tracks`}
                        {c.bookmarks > 0 &&
                          ` · ${count(c.bookmarks)} saved places`}
                      </p>
                    </div>
                  )
                  : preview.exactFileMatch
                  ? (
                    <div>
                      <p className="font-medium">
                        This file is already imported.
                      </p>
                      <p className="text-muted-foreground">
                        It matches “{preview.exactFileMatch.filename}”
                        {preview.exactFileMatch.createdAt &&
                          ` from ${
                            new Date(preview.exactFileMatch.createdAt)
                              .toLocaleString()
                          }`}.
                      </p>
                    </div>
                  )
                  : (
                    <>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                        <div>
                          <strong>{count(c.newPoints)}</strong>
                          <br />new GPS points
                        </div>
                        <div>
                          <strong>{count(c.matchedPoints)}</strong>
                          <br />already present
                        </div>
                        <div>
                          <strong>{count(c.tracks)}</strong>
                          <br />tracks/routes
                        </div>
                        <div>
                          <strong>{count(c.bookmarks)}</strong>
                          <br />saved places
                        </div>
                      </div>
                      <details className="rounded bg-muted/50 p-2 text-xs">
                        <summary className="cursor-pointer font-medium">
                          Complete file profile
                        </summary>
                        <div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                          <p>
                            Coordinates: {count(c.trackCoordinates)} route ·
                            {" "}
                            {count(c.timedCoordinates)} timed · {count(
                              c.untimedCoordinates,
                            )} untimed
                          </p>
                          <p>
                            Tracks: {count(c.timedTracks)} timed · {count(
                              c.untimedTracks,
                            )} untimed · {count(c.mixedTracks)} mixed
                          </p>
                          <p>
                            Quality: {count(c.invalidCoordinates)}{" "}
                            invalid coordinates · {count(c.invalidTimestamps)}
                            {" "}
                            invalid times
                          </p>
                          <p>
                            Pairing: {count(c.unpairedCoordinates)}{" "}
                            without time · {count(c.unpairedTimestamps)}{" "}
                            times without coordinates
                          </p>
                          <p>
                            Styles: {count(c.styleDefinitions)}{" "}
                            · unsupported geometry:{" "}
                            {count(c.unsupportedGeometries)}
                          </p>
                        </div>
                      </details>
                      {(c.untimedCoordinates > 0 ||
                        c.withinFileDuplicates > 0 ||
                        c.withinFileTrackDuplicates > 0 ||
                        c.withinFileBookmarkDuplicates > 0) && (
                        <p className="text-xs text-muted-foreground">
                          {c.untimedCoordinates > 0 &&
                            `${
                              count(c.untimedCoordinates)
                            } untimed route coordinates will be saved for the map.`}
                          {c.untimedCoordinates > 0 &&
                            c.withinFileDuplicates > 0 && " "}
                          {c.withinFileDuplicates > 0 &&
                            `${
                              count(c.withinFileDuplicates)
                            } repeated points inside the file will be linked once.`}
                          {(c.withinFileTrackDuplicates > 0 ||
                            c.withinFileBookmarkDuplicates > 0) &&
                            ` ${
                              count(c.withinFileTrackDuplicates)
                            } repeated tracks and ${
                              count(c.withinFileBookmarkDuplicates)
                            } repeated saved places will be stored once with all source references.`}
                        </p>
                      )}
                      {preview.duplicateSources.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Existing matches:{" "}
                          {preview.duplicateSources.slice(0, 3).map((source) =>
                            `${source.filename} (${
                              count(source.matchedPoints)
                            })`
                          ).join(", ")}.
                        </p>
                      )}
                      {c.conflictGroups > 0 && (
                        <div className="flex gap-2 rounded bg-amber-500/10 p-2 text-xs">
                          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
                          <p>
                            {count(c.conflictGroups)}{" "}
                            times contain different coordinate sets. They will
                            be saved for review and will not change the current
                            route.
                          </p>
                        </div>
                      )}
                      {c.metadataReview > 0 && (
                        <details className="rounded bg-muted/60 p-2 text-xs">
                          <summary className="cursor-pointer font-medium">
                            {count(c.metadataReview)}{" "}
                            metadata differences retained for review
                          </summary>
                          <div className="mt-2 space-y-1 font-mono text-muted-foreground">
                            {preview.metadataDifferences.map((
                              difference,
                              index,
                            ) => (
                              <p
                                key={`${difference.kind}-${
                                  difference.hash ?? difference.coordinateHash
                                }-${index}`}
                              >
                                {difference.kind === "elevation"
                                  ? `Elevation: existing ${difference.existing} m, incoming ${difference.incoming} m (${difference.hash})`
                                  : difference.kind === "ambiguous_bookmark"
                                  ? `Multiple saved places share ${difference.coordinateHash}; the incoming item stays separate.`
                                  : `${difference.entityType} ${difference.field}: existing ${
                                    JSON.stringify(difference.existingValue)
                                  }, incoming ${
                                    JSON.stringify(difference.incomingValue)
                                  }`}
                              </p>
                            ))}
                          </div>
                        </details>
                      )}
                      <div className="flex items-center justify-between gap-3 pt-1">
                        <p className="text-xs text-muted-foreground">
                          Existing canonical coordinates will not be replaced.
                        </p>
                        <Button
                          size="sm"
                          disabled={!preview.canConfirm ||
                            confirming.has(preview.previewId)}
                          onClick={() => confirmPreview(preview)}
                        >
                          {confirming.has(preview.previewId) &&
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                          {confirmLabel(preview)}
                        </Button>
                      </div>
                    </>
                  )}
              </section>
            );
          })}
        </div>

        {(imports?.length ?? 0) > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Previous imports
            </p>
            <div className="max-h-52 overflow-y-auto">
              <ImportsList enabled={open} onShowOnMap={onShowImportOnMap} />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
