import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useMongoChanges } from "@/hooks/useMongoChanges";
import { api } from "@/lib/api";
import { ObjectId } from "bson";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FileAudio,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Download,
  Search,
  Upload,
  RotateCcw,
  X
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface SourceFile {
  _id: any;
  path: string;
  ingested: boolean;
  start?: any;
  ingestion?: {
    error?: any;
    last_attempt?: any;
    recovery?: string;
  };
}

interface TreeNode {
  name: string;
  fullPath: string;
  children: Record<string, TreeNode>;
  totalCount: number;
  ingestedCount: number;
  errorCount: number;
  type: 'folder' | 'file';
  id?: string;
  start?: any;
  hasError?: boolean;
}

function formatDate(date: any): string {
  if (!date) return "";
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return "";
  }
}

function buildTree(files: SourceFile[]): TreeNode {
  const root: TreeNode = {
    name: "root",
    fullPath: "",
    children: {},
    totalCount: 0,
    ingestedCount: 0,
    errorCount: 0,
    type: 'folder'
  };

  for (const file of files) {
    const path = file.path || "unknown";
    // Split by / or \ for cross-platform compatibility
    const parts = path.split(/[/\\]/).filter(Boolean);
    let current = root;

    current.totalCount++;
    if (file.ingested) current.ingestedCount++;
    if (file.ingestion?.error) current.errorCount++;

    let currentPath = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath += (currentPath ? "/" : "") + part;
      const isFile = i === parts.length - 1;

      if (!current.children[part]) {
        current.children[part] = {
          name: part,
          fullPath: currentPath,
          children: {},
          totalCount: 0,
          ingestedCount: 0,
          errorCount: 0,
          type: isFile ? 'file' : 'folder',
          id: isFile ? file._id?.toString() : undefined,
          start: isFile ? file.start : undefined,
          hasError: isFile ? !!file.ingestion?.error : undefined
        };
      }

      const node = current.children[part];
      node.totalCount++;
      if (file.ingested) node.ingestedCount++;
      if (file.ingestion?.error) node.errorCount++;

      current = node;
    }
  }

  return root;
}

function collapseTree(node: TreeNode): TreeNode {
  const childrenKeys = Object.keys(node.children);

  // Recursively collapse children first
  for (const key of childrenKeys) {
    node.children[key] = collapseTree(node.children[key]);
  }

  // If this node has exactly one child and it's a folder, collapse it
  if (childrenKeys.length === 1) {
    const singleChildKey = childrenKeys[0];
    const child = node.children[singleChildKey];

    if (child.type === 'folder') {
      return {
        ...child,
        name: `${node.name}/${child.name}`,
        totalCount: node.totalCount,
        ingestedCount: node.ingestedCount,
        errorCount: node.errorCount,
        id: child.id
      };
    }
  }

  return node;
}

const TreeItem = ({ node, level = 0, onRetry, retryingIds, queuedRetryIds }: { node: TreeNode; level?: number; onRetry?: (id: string) => void; retryingIds: Set<string>; queuedRetryIds: Set<string> }) => {
  const [isExpanded, setIsExpanded] = useState(level === 0);
  const hasChildren = Object.keys(node.children).length > 0;

  const sortedChildren = useMemo(() => {
    return Object.values(node.children).sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [node.children]);

  const allIngested = node.ingestedCount === node.totalCount;
  const someIngested = node.ingestedCount > 0;
  const dateStr = node.type === 'file' ? formatDate(node.start) : "";

  const content = (
    <div
      className={cn(
        "grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-1 rounded-md px-2 py-1.5 text-sm hover:bg-accent lg:grid-cols-[auto_auto_minmax(0,1fr)_auto]",
        node.type === "folder" && "cursor-pointer",
        level === 0 && "font-semibold bg-muted/50"
      )}
      style={{ paddingLeft: `min(${0.5 + level * 0.875}rem, 14%)` }}
      role={node.type === 'folder' ? 'button' : undefined}
      tabIndex={node.type === 'folder' ? 0 : undefined}
      aria-expanded={node.type === 'folder' ? isExpanded : undefined}
      onKeyDown={event => { if (node.type === 'folder' && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setIsExpanded(!isExpanded); } }}
      onClick={() => node.type === 'folder' && setIsExpanded(!isExpanded)}
    >
      <span className="size-4 flex items-center justify-center">
        {hasChildren ? (
          isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />
        ) : null}
      </span>

      <span className="text-muted-foreground">
        {node.type === 'folder' ? (
          <Folder className={cn("w-4 h-4", isExpanded && "fill-current opacity-20")} />
        ) : (
          <FileAudio className="w-4 h-4" />
        )}
      </span>

      {node.type === 'file' && node.id ? <Link title={node.fullPath} className="min-w-0 truncate hover:underline focus-visible:outline" to={`/audio/source_files/${node.id}`}>{node.name}</Link> : <span title={node.fullPath} className="min-w-0 truncate">{node.name}</span>}

      <div className="col-span-3 flex flex-wrap items-center gap-x-3 gap-y-1 pl-5 text-xs lg:col-span-1 lg:justify-end">
        {dateStr && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {dateStr}
          </span>
        )}

        {node.type === 'file' && node.hasError && node.id && onRetry && (
          <Button
            variant="ghost"
            size="sm"
            disabled={retryingIds.has(node.id) || queuedRetryIds.has(node.id)}
            aria-label={`Retry ${node.name}`}
            className="h-7 px-2 text-xs text-orange-600 hover:text-orange-700 hover:bg-orange-50"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRetry(node.id!);
            }}
          >
            <RotateCcw className="w-3 h-3 mr-1" />
            {queuedRetryIds.has(node.id) ? "Queued" : retryingIds.has(node.id) ? "Queuing…" : "Retry"}
          </Button>
        )}

        <div className="flex items-center gap-1.5 min-w-[60px] justify-end">
          <span className="text-xs text-muted-foreground">Ingested</span>
          <CheckCircle2 className={cn(
            "w-3.5 h-3.5",
            allIngested ? "text-green-500" : someIngested ? "text-yellow-500" : "text-muted-foreground"
          )} />
          <span className={cn(
            "font-mono text-xs",
            allIngested ? "text-green-600 dark:text-green-400" : someIngested ? "text-yellow-600 dark:text-yellow-400" : ""
          )}>
            {node.ingestedCount}/{node.totalCount}
          </span>
        </div>

        <div className="flex items-center gap-1.5 min-w-[40px] justify-end">
          <span className="text-xs text-muted-foreground">Errors</span>
          <AlertCircle className={cn(
            "w-3.5 h-3.5",
            node.errorCount > 0 ? "text-destructive" : "text-muted-foreground"
          )} />
          <span className={cn(
            "font-mono text-xs",
            node.errorCount > 0 ? "text-destructive" : "text-muted-foreground"
          )}>
            {node.errorCount}
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="select-none">
      {content}

      {isExpanded && hasChildren && (
        <div className="mt-0.5">
          {sortedChildren.map(child => (
            <TreeItem key={child.fullPath} node={child} level={level + 1} onRetry={onRetry} retryingIds={retryingIds} queuedRetryIds={queuedRetryIds} />
          ))}
        </div>
      )}
    </div>
  );
};

interface UploadingFile {
  file: File;
  progress: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
}

export default function AudioSourceFilesPage() {
  const queryClient = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const retryRequests = useRef(new Set<string>());
  const [queuedRetryIds, setQueuedRetryIds] = useState<Set<string>>(new Set());
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());

  // Use React Query cache to persist files across detail page navigation
  const { data: fetchedFiles = [] } = useQuery<SourceFile[]>({
    queryKey: ["source-files-list"],
    queryFn: () => queryClient.getQueryData<SourceFile[]>(["source-files-list"]) ?? [],
    staleTime: Infinity, // Don't re-fetch automatically while on page
    gcTime: 1000 * 60 * 10, // Keep in cache for 10 minutes
  });

  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<'all' | 'ingested' | 'error' | 'pending'>('all');

  const setFetchedFiles = (updater: (prev: SourceFile[]) => SourceFile[]) => {
    if (!mounted.current) return;
    queryClient.setQueryData<SourceFile[]>(["source-files-list"], (old = []) => updater(old));
  };

  const fetchInBatches = async () => {
    setIsDownloading(true);
    setError(null);
    setFetchedFiles(() => []);

    try {
      const count = await api.callResource("mongo", {
        action: "count",
        collection: "source_files",
        query: {}
      });

      if (!mounted.current) return;
      const total = typeof count === 'number' ? count : (count?.count ?? 0);
      setTotalCount(total);

      const batchSize = 1000;
      const all: SourceFile[] = [];

      for (let skip = 0; skip < total; skip += batchSize) {
        const batch = await api.callResource("mongo", {
          action: "find",
          collection: "source_files",
          query: {},
          options: {
            limit: batchSize,
            skip: skip,
            projection: {
              _id: 1,
              path: 1,
              ingested: 1,
              start: 1,
              "ingestion.error": 1, "ingestion.recovery": 1
            }
          }
        });

        if (!mounted.current) return;
        all.push(...batch);
        setFetchedFiles(() => [...all]);
      }
    } catch (err: any) {
      console.error("Failed to fetch source files:", err);
      setError(err.message || "Failed to download records");
    } finally {
      setIsDownloading(false);
    }
  };

  useEffect(() => {
    // Only fetch if we don't have data yet
    if (fetchedFiles.length === 0) {
      fetchInBatches();
    }
  }, []);

  // Handle "only re-fetch all data when leaving the page"
  useEffect(() => {
    return () => {
      // If we are navigating away from the source files area entirely
      const currentPath = window.location.pathname;
      if (!currentPath.startsWith("/audio/source_files")) {
        queryClient.invalidateQueries({ queryKey: ["source-files-list"] });
      }
    };
  }, [queryClient]);

  useMongoChanges("mongo:source_files", (changes) => {
    const ids = [...new Set(changes.filter(change => change.collection === "source_files").map(change => change.documentId))];
    if (!ids.length) return;
    const settled = changes.filter(change => change.operationType === "delete" || change.changedFields?.some(field => field === "ingested" || field === "ingestion" || field.startsWith("ingestion."))).map(change => change.documentId);
    for (const id of settled) retryRequests.current.delete(id);
    setQueuedRetryIds(previous => new Set([...previous].filter(id => !settled.includes(id))));
    return (async () => {
      try {
        for (let offset = 0; offset < ids.length; offset += 100) {
          const batchIds = ids.slice(offset, offset + 100);
          const rows = await api.callResource("mongo", {
            action: "find", collection: "source_files",
            query: { _id: { $in: batchIds.map(id => ObjectId.isValid(id) ? new ObjectId(id) : id) } },
            options: { limit: 100, projection: { _id: 1, path: 1, ingested: 1, start: 1, "ingestion.error": 1, "ingestion.recovery": 1 } },
          }) as SourceFile[];
          if (!mounted.current) return;
          const changed = new Set(batchIds);
          setFetchedFiles(previous => [...previous.filter(file => !changed.has(file._id?.toString() ?? "")), ...rows]);
        }
        const count = await api.callResource("mongo", { action: "count", collection: "source_files", query: {} });
        setTotalCount(typeof count === "number" ? count : count?.count ?? 0);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Source updates could not be refreshed. Refresh the list to try again.");
      }
    })();
  });

  // Upload handling
  const handleFiles = useCallback((files: FileList | File[]) => {
    const allFiles = Array.from(files);
    const audioFiles = allFiles.filter(f =>
      f.type.startsWith("audio/") ||
      f.type === "video/mp4" ||
      /\.(wav|mp3|m4a|flac|opus|ogg|aac|wma|mp4)$/i.test(f.name)
    );
    const rejected = allFiles.filter(f => !audioFiles.includes(f));
    if (rejected.length > 0) {
      const names = rejected.map(f => f.name).join(", ");
      toast.error(`Unsupported format: ${names}`, {
        description: "Supported: WAV, MP3, M4A, MP4, FLAC, OPUS, OGG, AAC, WMA",
      });
    }
    if (audioFiles.length === 0) return;
    setUploadingFiles(prev => [
      ...prev,
      ...audioFiles.map(file => ({ file, progress: 'pending' as const }))
    ]);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }, [handleFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const removeUploadFile = (index: number) => {
    setUploadingFiles(prev => prev.filter((_, i) => i !== index));
  };

  const startUpload = async () => {
    if (uploadingFiles.length === 0) return;
    setIsUploading(true);

    const formData = new FormData();
    for (const uf of uploadingFiles) {
      if (uf.progress === 'pending') {
        formData.append("files", uf.file);
      }
    }

    setUploadingFiles(prev => prev.map(uf =>
      uf.progress === 'pending' ? { ...uf, progress: 'uploading' as const } : uf
    ));

    try {
      const authHeaders = await api.getAuthHeaders();
      const response = await fetch(`${api.baseURL}/api/audio/upload`, {
        method: "POST",
        body: formData,
        headers: authHeaders, // No Content-Type - let browser set multipart boundary
      });
      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
      }
      const result = await response.json();

      setUploadingFiles(prev => prev.map((uf, i) => {
        const fileResult = result.results?.find((r: any) => r.filename === uf.file.name);
        if (fileResult?.error) {
          return { ...uf, progress: 'error' as const, error: fileResult.error };
        }
        return { ...uf, progress: 'done' as const };
      }));

      // Refresh the file list after upload
      setTimeout(() => fetchInBatches(), 1000);
    } catch (err: any) {
      setUploadingFiles(prev => prev.map(uf =>
        uf.progress === 'uploading' ? { ...uf, progress: 'error' as const, error: err.message } : uf
      ));
    } finally {
      setIsUploading(false);
    }
  };

  const clearCompletedUploads = () => {
    setUploadingFiles(prev => prev.filter(uf => uf.progress !== 'done'));
  };

  // Retry handling
  const handleRetry = async (fileId: string) => {
    if (retryRequests.current.has(fileId)) return;
    const source = fetchedFiles.find(file => file._id?.toString() === fileId);
    if (!source?.path || source.ingestion?.recovery === "reupload") {
      toast.error("Upload this file again to retry. Its completed audio chunks remain preserved.");
      return;
    }
    retryRequests.current.add(fileId);
    setRetryingIds(prev => new Set([...prev, fileId]));
    try {
      await api.callResource("jobs", {
        action: "enqueue", data: { type: "ingestion", sourceIds: [fileId], retryErrors: true, limit: 1 },
        trigger: { type: "manual", reason: "source_file_retry" },
      });
      setQueuedRetryIds(previous => new Set([...previous, fileId]));
      toast.success("Retry queued. The source error remains visible until ingestion succeeds.");
    } catch (err) {
      retryRequests.current.delete(fileId);
      toast.error(err instanceof Error ? err.message : "Could not queue ingestion retry.");
    } finally {
      setRetryingIds(prev => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  };

  const handleRetryAll = async () => {
    const errorFiles = fetchedFiles.filter(f => f.ingestion?.error);
    for (const file of errorFiles) {
      await handleRetry(file._id?.toString());
    }
  };

  const tree = useMemo(() => {
    if (fetchedFiles.length === 0) return null;

    let filteredFiles = fetchedFiles;

    // Apply status filter
    if (statusFilter === 'ingested') {
      filteredFiles = filteredFiles.filter(f => f.ingested);
    } else if (statusFilter === 'error') {
      filteredFiles = filteredFiles.filter(f => f.ingestion?.error);
    } else if (statusFilter === 'pending') {
      filteredFiles = filteredFiles.filter(f => !f.ingested && !f.ingestion?.error);
    }

    // Apply search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filteredFiles = filteredFiles.filter(f => f.path.toLowerCase().includes(query));
    }

    const fullTree = buildTree(filteredFiles);

    // Collapse all children of root, but don't collapse root itself into its children
    const childrenKeys = Object.keys(fullTree.children);
    for (const key of childrenKeys) {
      fullTree.children[key] = collapseTree(fullTree.children[key]);
    }

    return fullTree;
  }, [fetchedFiles, searchQuery, statusFilter]);

  // Original tree stats for the chips
  const baseStats = useMemo(() => {
    if (fetchedFiles.length === 0) return { ingested: 0, error: 0, pending: 0, total: 0 };
    let ingested = 0;
    let error = 0;
    let pending = 0;
    for (const f of fetchedFiles) {
      if (f.ingested) ingested++;
      else if (f.ingestion?.error) error++;
      else pending++;
    }
    return { ingested, error, pending, total: fetchedFiles.length };
  }, [fetchedFiles]);

  const progress = totalCount ? (fetchedFiles.length / totalCount) * 100 : 0;

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audio Source Files</h1>
          <p className="text-muted-foreground mt-1">
            Hierarchy of discovered audio files and their ingestion status.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {baseStats.error > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetryAll}
              disabled={retryingIds.size > 0 || fetchedFiles.filter(file => file.ingestion?.error).every(file => queuedRetryIds.has(file._id?.toString()))}
              className="text-orange-600 border-orange-200 hover:bg-orange-50"
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              Retry All Errors ({baseStats.error})
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchInBatches()}
            disabled={isDownloading}
          >
            <RefreshCw className={cn("h-4 w-4 mr-2", isDownloading && "animate-spin")} />
            {isDownloading ? "Downloading..." : "Refresh"}
          </Button>
        </div>
      </div>

      {/* Upload Area */}
      <Card
        className={cn(
          "border-2 border-dashed transition-colors",
          isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/20"
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Upload className={cn("size-6 shrink-0", isDragging ? "text-primary" : "text-muted-foreground")} />
            <div className="min-w-0 flex-1 basis-52">
              <p className="font-medium">
                {isDragging ? "Drop audio files here" : "Drag & drop audio files to upload"}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                WAV, MP3, M4A, MP4, FLAC, OPUS, OGG supported
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              Browse Files
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="audio/*,.wav,.mp3,.m4a,.flac,.opus,.ogg,.aac,.wma,.mp4"
              className="hidden"
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
            />
          </div>

          {uploadingFiles.length > 0 && (
            <div className="mt-4 space-y-2 border-t pt-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{uploadingFiles.length} file(s) selected</span>
                <div className="flex gap-2">
                  {uploadingFiles.some(uf => uf.progress === 'done') && (
                    <Button variant="ghost" size="sm" onClick={clearCompletedUploads}>
                      Clear completed
                    </Button>
                  )}
                  {uploadingFiles.some(uf => uf.progress === 'pending') && (
                    <Button size="sm" onClick={startUpload} disabled={isUploading}>
                      {isUploading ? (
                        <>
                          <RefreshCw className="w-3 h-3 mr-1 animate-spin" />
                          Uploading...
                        </>
                      ) : (
                        <>
                          <Upload className="w-3 h-3 mr-1" />
                          Upload
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {uploadingFiles.map((uf, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-muted/50">
                    <FileAudio className="w-3 h-3 text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate">{uf.file.name}</span>
                    <span className="text-muted-foreground shrink-0">
                      {(uf.file.size / 1024 / 1024).toFixed(1)} MB
                    </span>
                    {uf.progress === 'done' && <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />}
                    {uf.progress === 'error' && (
                      <span className="text-destructive" title={uf.error}>
                        <AlertCircle className="w-3 h-3" />
                      </span>
                    )}
                    {uf.progress === 'uploading' && <RefreshCw className="w-3 h-3 animate-spin text-primary shrink-0" />}
                    {uf.progress === 'pending' && (
                      <button type="button" aria-label={`Remove ${uf.file.name} from upload queue`} onClick={() => removeUploadFile(i)} className="text-muted-foreground hover:text-foreground">
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {isDownloading && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-4">
            <div className="space-y-4">
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <Download className="w-4 h-4 animate-bounce text-primary" />
                  <span className="font-medium">Downloading records in batches...</span>
                </div>
                <span className="font-mono text-muted-foreground">
                  {fetchedFiles.length} / {totalCount ?? "?"}
                </span>
              </div>
              <Progress value={progress} className="h-2" />
              <p className="text-xs text-muted-foreground text-center">
                Fetching records 1000 at a time to ensure stability with large datasets.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card className="border-destructive/20 bg-destructive/5">
          <CardContent className="pt-4 pb-4 flex items-center gap-3 text-destructive">
            <AlertCircle className="w-5 h-5" />
            <div className="flex-1 text-sm font-medium">{error}</div>
            <Button size="sm" variant="outline" onClick={() => fetchInBatches()}>Try Again</Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="space-y-3">
            <CardTitle className="text-lg">Source File Hierarchy</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 basis-52">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  aria-label="Filter paths"
                  placeholder="Filter paths..."
                  className="pl-8"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Ingestion status">
                {([
                  ["all", "Total", baseStats.total],
                  ["ingested", "Ingested", baseStats.ingested],
                  ["error", "Errors", baseStats.error],
                  ["pending", "Pending", baseStats.pending],
                ] as const).map(([status, label, count]) => (
                  <Button
                    key={status}
                    variant={statusFilter === status ? "default" : "outline"}
                    size="sm"
                    aria-pressed={statusFilter === status}
                    onClick={() => setStatusFilter(statusFilter === status ? "all" : status)}
                  >
                    {label}: {count}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-3">
          {fetchedFiles.length === 0 && isDownloading ? (
            <div className="flex flex-col items-center justify-center py-8 space-y-2">
              <RefreshCw className="h-10 w-10 animate-spin text-primary opacity-50" />
              <p className="text-muted-foreground animate-pulse">Initializing download...</p>
            </div>
          ) : tree && tree.totalCount > 0 ? (
            <div className="min-w-0">
               <div className="max-h-[75vh] overflow-y-auto">
                  {Object.values(tree.children).length > 0 ? (
                    Object.values(tree.children)
                      .sort((a, b) => {
                        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
                        return a.name.localeCompare(b.name);
                      })
                      .map(node => <TreeItem key={node.fullPath} node={node} onRetry={handleRetry} retryingIds={retryingIds} queuedRetryIds={queuedRetryIds} />)
                  ) : (
                    <TreeItem node={tree} onRetry={handleRetry} retryingIds={retryingIds} queuedRetryIds={queuedRetryIds} />
                  )}
               </div>
            </div>
          ) : !isDownloading ? (
            <div className="rounded-lg bg-muted/30 px-3 py-8 text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-muted mb-4">
                <Folder className="w-6 h-6 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium">{baseStats.total > 0 ? "No files match these filters" : "No source files found"}</h3>
              <p className="text-muted-foreground max-w-xs mx-auto mt-2">
                {baseStats.total > 0
                  ? "Try a different path or ingestion status."
                  : "Upload audio files above or check that discovery is running."}
              </p>
              {baseStats.total > 0 ? (
                <Button variant="outline" className="mt-3" onClick={() => {
                  setStatusFilter('all');
                  setSearchQuery("");
                }}>Clear filters</Button>
              ) : <Button variant="outline" className="mt-3" onClick={() => fetchInBatches()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Try again
              </Button>}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
