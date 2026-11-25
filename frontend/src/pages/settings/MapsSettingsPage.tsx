import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  Database,
  Loader2,
  Map as MapIcon,
  RefreshCw,
  Upload,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { callResource } from "@/lib/api";
import { subscribeToJob } from "@/lib/jobs";
import {
  locationKeys,
  useLocationStatus,
} from "@/hooks/useLocationQueries";
import { ImportsList } from "@/components/location/ImportsList";
import { ImportTracksDialog } from "@/components/location/ImportTracksDialog";
import {
  DEFAULT_MAP_TILE_URL,
  useSettingsStore,
} from "@/stores/settingsStore";
import { useTrackVisibilityStore } from "@/stores/trackVisibilityStore";
import { useNavigate } from "react-router-dom";
import type { LocationImport } from "@/types/location";
import { UNKNOWN_LOCATION_PROVIDER } from "@myceliasdk/location-sources.ts";

interface GeonamesProgress {
  stage?: string;
  upserted?: number;
  total?: number;
}

export default function MapsSettingsPage() {
  const navigate = useNavigate();
  function showImportOnMap(imp: LocationImport) {
    navigate("/map", {
      state: { mapImport: {
        importId: String(imp._id), provider: imp.origin?.provider ?? UNKNOWN_LOCATION_PROVIDER,
        label: imp.filename,
      } },
    });
  }
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useLocationStatus();
  const { mapTileUrl, setMapTileUrl } = useSettingsStore();
  const { visibleTracks, toggleTrack } = useTrackVisibilityStore();

  const [tileDraft, setTileDraft] = useState(mapTileUrl);
  const [importOpen, setImportOpen] = useState(false);
  const [geonamesJob, setGeonamesJob] = useState<
    { jobId: string; progress: GeonamesProgress | null } | null
  >(null);
  const [reprocessing, setReprocessing] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => setTileDraft(mapTileUrl), [mapTileUrl]);
  useEffect(() => () => unsubscribeRef.current?.(), []);

  const startGeonamesDownload = async () => {
    try {
      const result = await callResource("jobs", {
        action: "enqueue",
        data: { type: "geonames_download" },
        trigger: {
          type: "manual",
          reason: "Places database download requested from Maps settings",
        },
      });
      const jobId: string = result.jobId;
      setGeonamesJob({ jobId, progress: null });
      unsubscribeRef.current?.();
      unsubscribeRef.current = subscribeToJob(jobId, (update) => {
        if (update.state === "completed") {
          setGeonamesJob(null);
          toast.success("Places database is up to date.");
          queryClient.invalidateQueries({ queryKey: locationKeys.all });
          unsubscribeRef.current?.();
        } else if (update.state === "failed") {
          setGeonamesJob(null);
          toast.error(
            `Places database download failed: ${
              update.failedReason ?? "unknown error"
            }`,
          );
          unsubscribeRef.current?.();
        } else if (update.progress) {
          setGeonamesJob({
            jobId,
            progress: update.progress as GeonamesProgress,
          });
        }
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to start download",
      );
    }
  };

  const reprocessAll = async () => {
    setReprocessing(true);
    try {
      await callResource("jobs", {
        action: "enqueue",
        data: {
          type: "location_processing",
          start: "2000-01-01T00:00:00Z",
          end: new Date().toISOString(),
        },
        trigger: {
          type: "manual",
          reason: "Full location reprocessing requested from Maps settings",
        },
      });
      toast.success(
        "Reprocessing started — segments and timezone periods rebuild in the background.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to enqueue");
    } finally {
      setReprocessing(false);
    }
  };

  const progress = geonamesJob?.progress;
  const progressPct = progress?.total && progress?.upserted
    ? Math.round((progress.upserted / progress.total) * 100)
    : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-2">Maps</h2>
        <p className="text-muted-foreground">
          Places database, GPS track imports and map preferences.
        </p>
      </div>

      {/* GeoNames */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            Places database (GeoNames)
          </CardTitle>
          <CardDescription>
            Offline city database used to name your stays and search places —
            coordinates never leave this server.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading
            ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            : status?.geonamesReady
            ? (
              <div className="text-sm">
                <Badge variant="secondary" className="mr-2">Loaded</Badge>
                {status.geonamesCount.toLocaleString()} cities
                {status.geonamesRefreshedAt && (
                  <span className="text-muted-foreground">
                    {" · updated "}
                    {new Date(status.geonamesRefreshedAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            )
            : (
              <p className="text-sm text-amber-600">
                Not downloaded — stays will have no place names until you
                download it (~13 MB, one time).
              </p>
            )}

          {geonamesJob
            ? (
              <div className="space-y-1.5">
                <Progress value={progressPct ?? undefined} className="h-2" />
                <p className="text-xs text-muted-foreground">
                  {progress?.stage === "downloading" && "Downloading dump…"}
                  {progress?.stage === "extracting" && "Extracting…"}
                  {progress?.stage === "upserting" &&
                    `Loading cities: ${
                      progress.upserted?.toLocaleString()
                    } / ${progress.total?.toLocaleString()}`}
                  {!progress?.stage && "Starting…"}
                </p>
              </div>
            )
            : (
              <Button
                variant={status?.geonamesReady ? "outline" : "default"}
                size="sm"
                onClick={startGeonamesDownload}
              >
                <Database className="mr-2 h-4 w-4" />
                {status?.geonamesReady
                  ? "Update database"
                  : "Download database"}
              </Button>
            )}
        </CardContent>
      </Card>

      {/* Imports */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Track imports
          </CardTitle>
          <CardDescription>
            GPX / KML / KMZ files imported so far. Deleting an import removes
            its GPS points and rebuilds the affected segments.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ImportsList manageSources onShowOnMap={showImportOnMap} />
          <Button size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="mr-2 h-4 w-4" />
            Import tracks…
          </Button>
        </CardContent>
      </Card>

      {/* Preferences */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapIcon className="h-5 w-5" />
            Map preferences
          </CardTitle>
          <CardDescription>
            Stored in this browser, like other client settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="tile-url">Tile server URL</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-0 basis-full @xl/settings:flex-1"
                id="tile-url"
                value={tileDraft}
                onChange={(e) => setTileDraft(e.target.value)}
                placeholder={DEFAULT_MAP_TILE_URL}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setMapTileUrl(tileDraft);
                  toast.success("Tile server updated.");
                }}
                disabled={tileDraft === mapTileUrl}
              >
                Save
              </Button>
              {mapTileUrl !== DEFAULT_MAP_TILE_URL && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setMapTileUrl(DEFAULT_MAP_TILE_URL);
                    toast.success("Tile server reset to OpenStreetMap.");
                  }}
                >
                  Reset
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Template with {"{z}/{x}/{y}"} placeholders. Point it at your own
              tile server for fully offline maps; default is
              openstreetmap.org.
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label htmlFor="locations-track">
                Show Locations track on the timeline
              </Label>
              <p className="text-xs text-muted-foreground">
                The track is lazy: hidden means zero location requests.
              </p>
            </div>
            <Switch
              id="locations-track"
              checked={visibleTracks.includes("locations")}
              onCheckedChange={() => toggleTrack("locations")}
            />
          </div>
        </CardContent>
      </Card>

      {/* Processing */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            Processing
          </CardTitle>
          <CardDescription>
            Stays = ≥10 min within ~200 m; silences over 30 min become assumed
            gaps; manual assignments always override imported data.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {status
              ? `${status.pointCount.toLocaleString()} GPS points · ${status.segmentCount.toLocaleString()} segments`
              : ""}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={reprocessAll}
            disabled={reprocessing}
          >
            {reprocessing
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <RefreshCw className="mr-2 h-4 w-4" />}
            Reprocess all location data
          </Button>
        </CardContent>
      </Card>

      <ImportTracksDialog open={importOpen} onOpenChange={setImportOpen} onShowImportOnMap={showImportOnMap} />
    </div>
  );
}
