import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { api } from "@/lib/api";
import { ObjectId } from "bson";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Calendar,
  ChevronDown,
  ChevronUp,
  Clock,
  FileCode,
  Globe,
  HardDrive,
  Layers,
  Monitor,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useState } from "react";
import { cn } from "@/lib/utils";

function formatBytes(bytes: number, decimals = 2) {
  if (!bytes) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export default function AudioSourceFileDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [isRawOpen, setIsRawOpen] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryStatus, setRetryStatus] = useState<
    { error?: string; jobId?: string } | null
  >(null);

  const {
    data: file,
    isLoading: isLoadingFile,
    error: fileError,
    refetch: refetchFile,
  } = useQuery({
    queryKey: ["source-file", id],
    queryFn: async () => {
      if (!id) throw new Error("ID is required");
      const response = await api.callResource("mongo", {
        action: "findOne",
        collection: "source_files",
        query: { _id: new ObjectId(id) },
      });
      return response;
    },
    enabled: !!id,
  });

  const {
    data: chunksCount,
    isLoading: isLoadingChunks,
    refetch: refetchChunks,
  } = useQuery({
    queryKey: ["source-file-chunks-count", id],
    queryFn: async () => {
      if (!id) return 0;
      const count = await api.callResource("mongo", {
        action: "count",
        collection: "audio_chunks",
        query: { original_id: new ObjectId(id) },
      });
      return typeof count === "number" ? count : (count?.count ?? 0);
    },
    enabled: !!id,
  });

  const isLoading = isLoadingFile || isLoadingChunks;
  const refetch = () => {
    refetchFile();
    refetchChunks();
  };

  const InfoRow = (
    { label, value, icon: Icon }: {
      label: string;
      value: React.ReactNode;
      icon?: any;
    },
  ) => {
    if (value === undefined || value === null) return null;
    return (
      <div className="flex items-start gap-3 py-3">
        {Icon && (
          <Icon className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
        )}
        <div className="flex-1 space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {label}
          </p>
          <div className="text-sm font-medium">{value}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/audio/source_files">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              Source File Details
            </h1>
            <p className="text-muted-foreground font-mono text-xs mt-1">{id}</p>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isLoading}
        >
          <RefreshCw
            className={cn("h-4 w-4 mr-2", isLoading && "animate-spin")}
          />
          Reload
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl">File Information</CardTitle>
              {file && (
                <Badge
                  variant={file.ingested ? "default" : "secondary"}
                  className={file.ingested
                    ? "bg-green-600 hover:bg-green-700"
                    : ""}
                >
                  {file.ingested ? "Ingested" : "Pending"}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
              <div className="space-y-1">
                <InfoRow
                  label="File Path"
                  value={
                    <span className="font-mono break-all text-xs">
                      {file?.path}
                    </span>
                  }
                  icon={HardDrive}
                />
                <InfoRow
                  label="File Size"
                  value={file?.size ? formatBytes(file.size) : "Unknown"}
                  icon={Activity}
                />
                <InfoRow
                  label="Start Time"
                  value={file?.start
                    ? format(new Date(file.start), "PPPpp")
                    : "Unknown"}
                  icon={Clock}
                />
              </div>
              <div className="space-y-1">
                <InfoRow
                  label="Created"
                  value={file?.created
                    ? format(new Date(file.created), "PPPpp")
                    : "-"}
                  icon={Calendar}
                />
                <InfoRow
                  label="Last Modified"
                  value={file?.modified
                    ? format(new Date(file.modified), "PPPpp")
                    : "-"}
                  icon={Calendar}
                />
                <InfoRow
                  label="Last Updated"
                  value={file?.updatedAt
                    ? format(new Date(file.updatedAt), "PPPpp")
                    : "-"}
                  icon={Calendar}
                />
              </div>
            </div>

            <Separator className="my-4" />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
              <div className="space-y-1">
                <InfoRow
                  label="System"
                  value={file?.platform?.system}
                  icon={Monitor}
                />
                <InfoRow
                  label="Node"
                  value={file?.platform?.node}
                  icon={Globe}
                />
              </div>
              <div className="space-y-1">
                <InfoRow
                  label="Importer"
                  value={
                    <Badge variant="outline" className="font-mono">
                      {file?.platform?.importer}
                    </Badge>
                  }
                  icon={Layers}
                />
                <InfoRow
                  label="Host"
                  value={file?.platform?.host}
                  icon={Globe}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Processing Stats</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between p-4 bg-primary/5 rounded-lg border border-primary/10">
              <div className="space-y-1">
                <p className="text-xs font-bold uppercase text-primary/70 tracking-tight">
                  Audio Chunks
                </p>
                <p className="text-3xl font-mono font-bold">
                  {chunksCount ?? 0}
                </p>
              </div>
              <div className="p-3 bg-primary/10 rounded-full">
                <Layers className="w-8 h-8 text-primary" />
              </div>
            </div>

            {file?.ingestion?.error && (
              <div className="p-4 bg-destructive/5 rounded-lg border border-destructive/10 space-y-3">
                <div className="flex items-center gap-2 text-destructive">
                  <AlertCircle className="w-4 h-4" />
                  <p className="text-xs font-bold uppercase tracking-tight">
                    Last Ingestion Error
                  </p>
                </div>
                <p className="text-sm font-medium text-destructive break-words">
                  {typeof file.ingestion.error === "string"
                    ? file.ingestion.error
                    : JSON.stringify(file.ingestion.error)}
                </p>
                {file.ingestion.last_attempt && (
                  <p className="text-[10px] text-muted-foreground">
                    Attempted:{" "}
                    {format(new Date(file.ingestion.last_attempt), "PPPpp")}
                  </p>
                )}
                {file.ingestion.recovery === "reupload" || !file.path
                  ? (
                    <p className="text-xs">
                      Upload this file again to retry. Completed audio chunks
                      remain preserved.
                    </p>
                  )
                  : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-orange-600 border-orange-200 hover:bg-orange-50"
                      disabled={isRetrying || Boolean(retryStatus?.jobId)}
                      onClick={async () => {
                        if (!id) return;
                        setIsRetrying(true);
                        setRetryStatus(null);
                        try {
                          const job = await api.callResource("jobs", {
                            action: "enqueue",
                            data: {
                              type: "ingestion",
                              sourceIds: [id],
                              retryErrors: true,
                              limit: 1,
                            },
                            trigger: { type: "manual", reason: "source_file_retry" },
                          });
                          setRetryStatus({ jobId: String(job?.jobId ?? "") });
                        } catch (err) {
                          setRetryStatus({
                            error: err instanceof Error
                              ? err.message
                              : "Could not queue ingestion retry",
                          });
                        } finally {
                          setIsRetrying(false);
                        }
                      }}
                    >
                      <RotateCcw
                        className={cn(
                          "w-3 h-3 mr-1",
                          isRetrying && "animate-spin",
                        )}
                      />
                      {isRetrying ? "Queuing..." : retryStatus?.jobId ? "Retry queued" : "Retry Ingestion"}
                    </Button>
                  )}
                {retryStatus && (
                  <p
                    role={retryStatus.error ? "alert" : "status"}
                    className="text-xs"
                  >
                    {retryStatus.error ?? (
                      <>
                        Retry queued.{" "}
                        <Link to="/jobs" className="underline">View jobs</Link>
                      </>
                    )}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Collapsible
        open={isRawOpen}
        onOpenChange={setIsRawOpen}
        className="w-full space-y-2"
      >
        <div className="flex items-center justify-between px-4 py-2 bg-muted/50 rounded-lg border">
          <div className="flex items-center gap-2">
            <FileCode className="w-4 h-4 text-muted-foreground" />
            <h4 className="text-sm font-semibold">Raw Document Data</h4>
          </div>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-9 p-0">
              {isRawOpen
                ? <ChevronUp className="h-4 w-4" />
                : <ChevronDown className="h-4 w-4" />}
              <span className="sr-only">Toggle raw data</span>
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="space-y-2">
          <Card>
            <CardContent className="pt-6">
              <pre className="p-4 rounded-md bg-muted font-mono text-xs overflow-auto max-h-[60vh] whitespace-pre-wrap">
                {JSON.stringify(file, (key, value) => {
                  if (value && value._bsontype === "ObjectID") return value.toString();
                  if (value && value._bsontype === "Binary") return "[Binary]";
                  return value;
                }, 2)}
              </pre>
            </CardContent>
          </Card>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
