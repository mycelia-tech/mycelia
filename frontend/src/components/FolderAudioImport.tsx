import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AudioOperations } from "./AudioOperationsCard";

type FolderSettings = { path: string; automatic: boolean };
const collection = "host_ingestion_config";
const query = { _id: "audio-folder" };

export function FolderAudioImport(
  { host }: { host?: AudioOperations["host"] },
) {
  const [path, setPath] = useState("");
  const [automatic, setAutomatic] = useState(true);
  const [dirty, setDirty] = useState(false);
  const saved = useQuery({
    queryKey: ["audio-folder-settings"],
    queryFn: () =>
      api.callResource("mongo", {
        action: "findOne",
        collection,
        query,
      }) as Promise<FolderSettings | null>,
    staleTime: 30_000,
    retry: false,
  });
  useEffect(() => {
    if (!dirty && saved.data) {
      setPath(saved.data.path);
      setAutomatic(saved.data.automatic);
    }
  }, [saved.data, dirty]);
  const save = useMutation({
    mutationFn: async () => {
      const value = path.trim();
      if (
        !(value.startsWith("/") || value.startsWith("~/")) || value === "/" ||
        value.includes("\0")
      ) {
        throw new Error("Enter an absolute folder path on the ingestion Mac.");
      }
      await api.callResource("mongo", {
        action: "updateOne",
        collection,
        query,
        update: { $set: { path: value, automatic } },
        options: { upsert: true },
      });
    },
    onSuccess: async () => {
      setDirty(false);
      await saved.refetch();
      toast.success(
        automatic
          ? "Folder saved. Automatic import starts with the next scan."
          : "Folder saved. Use Scan and import to start.",
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const run = useMutation({
    mutationFn: () =>
      api.callResource("jobs", {
        action: "enqueue",
        data: {
          type: "ingestion",
          sourceFolder: saved.data!.path,
          limit: 20,
        },
      }),
    onSuccess: () =>
      toast.success("Folder import queued. Follow progress in Jobs."),
    onError: (error) => toast.error(error.message),
  });
  const supported = host?.reachable && host.folderSource !== undefined;
  const folderError = saved.data && host?.lastCycle?.folder === saved.data.path
    ? host?.lastCycle?.error ||
      host?.lastCycle?.sources?.find((source) =>
        source.source === "selected_folder"
      )?.warning
    : undefined;
  return (
    <div className="space-y-3">
      <label className="block space-y-1 text-sm">
        <span>Folder on the ingestion Mac</span>
        <Input
          aria-label="Audio folder path"
          placeholder="/Users/you/Recordings"
          value={path}
          onChange={(event) => {
            setPath(event.target.value);
            setDirty(true);
          }}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={automatic}
          onChange={(event) => {
            setAutomatic(event.target.checked);
            setDirty(true);
          }}
        />
        Scan and import automatically
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!path.trim() || save.isPending || saved.isPending ||
            saved.isError || !supported}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save folder"}
        </Button>
        <Button
          size="sm"
          disabled={!saved.data || dirty || run.isPending || !host?.reachable ||
            saved.isError || save.isPending || !supported}
          onClick={() => run.mutate()}
        >
          {run.isPending ? "Queuing…" : "Scan and import"}
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link to="/jobs?type=ingestion">Progress</Link>
        </Button>
      </div>
      {host?.reachable && !supported && (
        <p className="text-xs text-muted-foreground">
          Update the host importer to enable folder selection.
        </p>
      )}
      {saved.data && (
        <p className="break-all text-xs text-muted-foreground">
          Saved: {saved.data.path} ·{" "}
          {saved.data.automatic ? "Automatic" : "Manual"}
        </p>
      )}
      {(saved.error || save.error || run.error || folderError) && (
        <p role="alert" className="text-sm text-destructive">
          {saved.error?.message || save.error?.message || run.error?.message ||
            folderError}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Only this folder and its subfolders. Up to 20 files per batch; automatic
        mode continues with the next batch.
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Supported folders</summary>
        <p className="mt-2">
          Audio files: M4A, MP3, WAV, Opus. A Voice Memos library with
          CloudRecordings.db preserves Apple dates and IDs. Exported files use
          file dates and paths. The folder must be readable by the daemon; the
          browser cannot grant macOS access.
        </p>
      </details>
    </div>
  );
}
