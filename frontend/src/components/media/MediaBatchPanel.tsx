import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderSearch,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { callResource } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { MediaHint } from "@/components/media/MediaHint";

const FOLDER_CAMPAIGN_KEY = "mycelia.media.folder-campaign";

function browserStorage(): Storage | undefined {
  try {
    return globalThis.document?.defaultView?.localStorage;
  } catch {
    return undefined;
  }
}

function storageGet(key: string): string | null {
  try {
    return browserStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    browserStorage()?.setItem(key, value);
  } catch {
    // The durable campaign lives in Mongo; browser storage is only a shortcut.
  }
}

function storageRemove(key: string): void {
  try {
    browserStorage()?.removeItem(key);
  } catch {
    // Ignore an unavailable browser storage implementation.
  }
}

function idOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "$oid" in value) {
    return String((value as { $oid: unknown }).$oid);
  }
  return String(value ?? "");
}

function countLine(counts: Record<string, number> | undefined) {
  if (!counts) return "Waiting for progress…";
  return [
    ["total", counts.total],
    ["imported", counts.imported],
    ["duplicate", counts.duplicate],
    ["unsupported", counts.unsupported],
    ["changed", counts.changed],
    ["pending", counts.pending],
    ["queued", counts.queued],
    ["processing", counts.processing],
    ["ready", counts.ready],
    ["failed", counts.failed],
    ["cancelled", counts.cancelled],
  ].filter(([, value]) => Number(value) > 0).map(([key, value]) =>
    `${key} ${value}`
  ).join(" · ") || "No items";
}

function durationLabel(seconds: number | undefined) {
  if (!Number.isFinite(seconds) || Number(seconds) < 0) return undefined;
  const rounded = Math.ceil(Number(seconds));
  if (rounded < 60) return `${rounded}s`;
  if (rounded < 3_600) return `${Math.ceil(rounded / 60)} min`;
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.ceil((rounded % 3_600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function timeAgo(value: unknown) {
  if (!value) return undefined;
  const elapsed = Math.max(0, Date.now() - new Date(String(value)).getTime());
  if (!Number.isFinite(elapsed)) return undefined;
  if (elapsed < 5_000) return "just now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

function campaignStageLabel(stage: string | undefined, status: string) {
  const labels: Record<string, string> = {
    inventory: "Building inventory",
    metadata_scan: "Scanning metadata",
    awaiting_confirmation: "Ready to review",
    creating_previews: "Importing locally",
    completed: "Finished",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return labels[stage ?? ""] ?? status.replaceAll("_", " ");
}

export function MediaBatchPanel({
  onInventoryChanged,
}: {
  status: any;
  onInventoryChanged: () => void | Promise<void>;
}) {
  const [relativePath, setRelativePath] = useState(".");
  const [folderListing, setFolderListing] = useState<any>({
    currentPath: ".",
    folders: [],
  });
  const [folderBrowserLoading, setFolderBrowserLoading] = useState(false);
  const [folderBrowserError, setFolderBrowserError] = useState<string>();
  const [folderCampaign, setFolderCampaign] = useState<any>();
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const inventoryFingerprintRef = useRef<string | undefined>(undefined);

  const loadFolderCampaign = useCallback(async (campaignId: string) => {
    const result = await callResource("media-library", {
      action: "getFolderCampaign",
      campaignId,
    });
    setFolderCampaign(result.campaign);
    return result.campaign;
  }, []);

  const loadActiveFolderCampaign = useCallback(async () => {
    const result = await callResource("media-library", {
      action: "getActiveFolderCampaign",
    });
    if (result.campaign) {
      const campaignId = idOf(result.campaign._id);
      storageSet(FOLDER_CAMPAIGN_KEY, campaignId);
      setFolderCampaign(result.campaign);
    }
    return result.campaign;
  }, []);

  const browseMountedFolder = useCallback(async (path: string) => {
    setFolderBrowserLoading(true);
    setFolderBrowserError(undefined);
    try {
      const result = await callResource("media-library", {
        action: "listMountedFolders",
        relativePath: path,
      });
      if (result?.listing?.currentPath) {
        setFolderListing(result.listing);
        setRelativePath(result.listing.currentPath);
      }
    } catch (error) {
      setFolderBrowserError(
        error instanceof Error
          ? error.message
          : "Mounted folders could not be listed",
      );
    } finally {
      setFolderBrowserLoading(false);
    }
  }, []);

  useEffect(() => {
    void browseMountedFolder(".");
  }, [browseMountedFolder]);

  useEffect(() => {
    const folderId = storageGet(FOLDER_CAMPAIGN_KEY);
    void (async () => {
      if (folderId) {
        try {
          await loadFolderCampaign(folderId);
          return;
        } catch {
          // A backend reload can make one request fail transiently. Recover the
          // durable campaign by owner instead of hiding its progress forever.
        }
      }
      try {
        const active = await loadActiveFolderCampaign();
        if (!active) storageRemove(FOLDER_CAMPAIGN_KEY);
      } catch {
        // Keep the existing shortcut and retry on the next page load.
      }
    })();
  }, [loadActiveFolderCampaign, loadFolderCampaign]);

  useEffect(() => {
    const activeFolder = folderCampaign && [
      "queued",
      "scanning",
      "importing",
    ].includes(folderCampaign.status);
    if (!activeFolder) return;
    const timer = globalThis.setInterval(() => {
      void loadFolderCampaign(idOf(folderCampaign._id)).catch(() => {
        // Keep the last known progress; the next poll retries after a reload.
      });
    }, 3_000);
    return () => globalThis.clearInterval(timer);
  }, [folderCampaign, loadFolderCampaign]);

  useEffect(() => {
    if (!folderCampaign) return;
    const fingerprint = JSON.stringify({
      id: idOf(folderCampaign._id),
      status: folderCampaign.status,
      updatedAt: folderCampaign.updatedAt,
      counts: folderCampaign.counts ?? {},
      progress: folderCampaign.progress
        ? {
          stage: folderCampaign.progress.stage,
          processed: folderCampaign.progress.processed,
          total: folderCampaign.progress.total,
          remaining: folderCampaign.progress.remaining,
          percent: folderCampaign.progress.percent,
        }
        : null,
    });
    if (inventoryFingerprintRef.current === fingerprint) return;
    inventoryFingerprintRef.current = fingerprint;
    void Promise.resolve(onInventoryChanged()).catch(() => {
      // A later durable campaign update retries a transient inventory refresh.
    });
  }, [folderCampaign, onInventoryChanged]);

  const startFolderScan = async () => {
    setBusy(true);
    try {
      const result = await callResource("media-library", {
        action: "startFolderScan",
        relativePath: relativePath.trim() || ".",
      });
      const campaignId = idOf(result.campaign._id);
      storageSet(FOLDER_CAMPAIGN_KEY, campaignId);
      setFolderCampaign(result.campaign);
      toast.success("Folder scan started; Google is not used during import");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Folder scan failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmFolderImport = async () => {
    if (!folderCampaign) return;
    if (
      !globalThis.confirm(
        `Import ${
          folderCampaign.counts?.total ?? 0
        } scanned entries as read-only references? Originals will not be copied or deleted.`,
      )
    ) return;
    setBusy(true);
    try {
      const result = await callResource("media-library", {
        action: "confirmFolderCampaign",
        campaignId: idOf(folderCampaign._id),
        confirm: true,
      });
      setFolderCampaign(result.campaign);
      toast.success("Background folder import started");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Import confirmation failed",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <Collapsible
          open={folderBrowserOpen}
          onOpenChange={setFolderBrowserOpen}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Folder className="h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="flex items-center gap-1">
                  <CardTitle className="text-base">Folder sync</CardTitle>
                  <MediaHint label="About folder sync">
                    Scans are local and recursive. Symlinks are ignored;
                    unchanged files reuse their verified SHA-256. Originals are
                    mounted read-only and Google is not called.
                  </MediaHint>
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {relativePath === "." ? "Local import folder" : relativePath}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="Choose mounted folder"
                >
                  Choose folder
                  <ChevronDown
                    className={`ml-2 h-4 w-4 transition-transform ${
                      folderBrowserOpen ? "rotate-180" : ""
                    }`}
                  />
                </Button>
              </CollapsibleTrigger>
              <Button
                onClick={startFolderScan}
                disabled={busy || folderBrowserLoading ||
                  Boolean(folderBrowserError) ||
                  Boolean(folderListing.scanUnavailableReason)}
                title={folderListing.scanUnavailableReason}
                size="sm"
                aria-label="Scan selected folder recursively"
              >
                {busy
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <FolderSearch className="mr-2 h-4 w-4" />}
                Scan
              </Button>
            </div>
          </div>

          <CollapsibleContent className="mt-3 space-y-2 border-t pt-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium">
                Import source and folder
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                aria-label="Refresh mounted folders"
                onClick={() =>
                  browseMountedFolder(folderListing.currentPath ?? ".")}
                disabled={folderBrowserLoading}
              >
                <RefreshCw
                  className={`h-4 w-4 ${
                    folderBrowserLoading ? "animate-spin" : ""
                  }`}
                />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Choose a local folder or open Connected disks. After connecting a
              disk, refresh this list. Only the selected folder is scanned;
              local scans do not include other sources.
            </p>
            {folderListing.scanUnavailableReason && (
              <p className="text-sm text-muted-foreground">
                {folderListing.scanUnavailableReason}
              </p>
            )}
            <div
              className="flex flex-wrap items-center gap-1 text-sm"
              aria-label="Selected mounted folder"
            >
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => browseMountedFolder(".")}
                disabled={folderBrowserLoading}
              >
                <Folder className="mr-1 h-4 w-4" /> Local import folder
              </Button>
              {(folderListing.currentPath === "."
                ? []
                : String(folderListing.currentPath).split("/"))
                .map((part: string, index: number, parts: string[]) => {
                  const path = parts.slice(0, index + 1).join("/");
                  return (
                    <span className="flex items-center" key={path}>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        onClick={() => browseMountedFolder(path)}
                        disabled={folderBrowserLoading}
                      >
                        {part}
                      </Button>
                    </span>
                  );
                })}
            </div>
            {folderListing.parentPath && (
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={() => browseMountedFolder(folderListing.parentPath)}
                disabled={folderBrowserLoading}
              >
                <ArrowUp className="mr-2 h-4 w-4" /> Parent folder
              </Button>
            )}
            <div
              className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-1"
              aria-label="Mounted subfolders"
            >
              {(folderListing.folders ?? []).map((folder: any) => (
                <Button
                  key={folder.relativePath}
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => browseMountedFolder(folder.relativePath)}
                  disabled={folderBrowserLoading ||
                    Boolean(folder.unavailableReason)}
                  title={folder.unavailableReason}
                >
                  <Folder className="mr-2 h-4 w-4 text-primary" />
                  {folder.name}
                  {folder.unavailableReason && (
                    <span className="ml-auto text-xs">Disk unavailable</span>
                  )}
                </Button>
              ))}
              {!folderBrowserLoading &&
                (folderListing.folders ?? []).length === 0 && (
                <div className="rounded bg-muted px-3 py-2 text-xs text-muted-foreground">
                  No child folders. You can scan this folder itself.
                </div>
              )}
            </div>
            {folderBrowserError && (
              <div className="text-sm text-destructive">
                {folderBrowserError}
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>

        {folderCampaign && (
          <div className="space-y-2 rounded-md bg-muted/60 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>
                {folderCampaign.progress?.waitingForRecovery
                  ? "Waiting for recovery"
                  : campaignStageLabel(
                    folderCampaign.progress?.stage,
                    folderCampaign.status,
                  )}
              </Badge>
              <code>{folderCampaign.relativePath}</code>
            </div>
            {folderCampaign.progress
              ? (
                <>
                  <div className="space-y-1.5">
                    <div className="flex justify-between gap-3 text-xs">
                      <span>{folderCampaign.progress.message}</span>
                      <strong>
                        {folderCampaign.progress.totalKnown === false
                          ? "Discovering…"
                          : `${folderCampaign.progress.percent.toFixed(1)}%`}
                      </strong>
                    </div>
                    <Progress
                      value={folderCampaign.progress.totalKnown === false
                        ? undefined
                        : folderCampaign.progress.percent}
                      className="h-2"
                    />
                    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        {folderCampaign.progress.totalKnown === false
                          ? `${folderCampaign.progress.processed} files discovered`
                          : `${folderCampaign.progress.processed} of ${folderCampaign.progress.total} ${
                            folderCampaign.progress.stage ===
                                "creating_previews"
                              ? "photos imported"
                              : "supported files checked"
                          }`}
                      </span>
                      {folderCampaign.progress.remaining > 0 && (
                        <span>
                          {folderCampaign.progress.remaining} remaining
                        </span>
                      )}
                    </div>
                  </div>
                  {folderCampaign.progress.totalKnown === false && (
                    <div className="truncate text-xs text-muted-foreground">
                      {folderCampaign.progress.currentPath}{" "}
                      · Total and ETA available after discovery
                    </div>
                  )}
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {folderCampaign.progress.filesPerSecond != null && (
                      <span>
                        {Number(folderCampaign.progress.filesPerSecond)
                          .toFixed(2)} files/sec
                      </span>
                    )}
                    {folderCampaign.progress.etaSeconds != null && (
                      <span>
                        about{" "}
                        {durationLabel(folderCampaign.progress.etaSeconds)}{" "}
                        remaining
                      </span>
                    )}
                    {folderCampaign.progress.lastProgressAt && (
                      <span>
                        last progress{" "}
                        {timeAgo(folderCampaign.progress.lastProgressAt)}
                      </span>
                    )}
                    <MediaHint label="Folder sync progress details">
                      Progress is saved every{" "}
                      {folderCampaign.progress.chunkSize} files.{" "}
                      {folderCampaign.progress.nextStep}
                    </MediaHint>
                  </div>
                </>
              )
              : <div>{countLine(folderCampaign.counts)}</div>}
            <div className="text-xs text-muted-foreground">
              {countLine(folderCampaign.counts)}
              {Number(folderCampaign.reusedHashCount ?? 0) > 0 && (
                <>· reused SHA {folderCampaign.reusedHashCount}</>
              )}
            </div>
            {folderCampaign.safeError && (
              <div className="text-destructive">
                {folderCampaign.safeError}
              </div>
            )}
            {folderCampaign.status === "preview_ready" && (
              <Button
                size="sm"
                onClick={confirmFolderImport}
                disabled={busy}
              >
                Confirm local import
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
