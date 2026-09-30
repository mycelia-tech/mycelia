import { useState } from "react";
import { toast } from "sonner";
import { callResource } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MediaHint } from "./MediaHint";

const idOf = (value: any) => String(value?.$oid ?? value ?? "");

export function FolderStreamControls({ campaign, status, onChange }: {
  campaign: any;
  status: any;
  onChange: (campaign: any) => void;
}) {
  const [open, setOpen] = useState(false);
  const [ceiling, setCeiling] = useState("50");
  const [batchSize, setBatchSize] = useState("100");
  const [preview, setPreview] = useState<any>();
  const [busy, setBusy] = useState(false);
  const profiles = (status?.profiles ?? []).filter((profile: any) =>
    profile.enabled && profile.providerType === "google-cloud"
  );
  const profile =
    profiles.find((entry: any) => entry.id === status?.activeProfileId) ??
      profiles[0];
  const stream = campaign.streaming;
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Stream request failed",
      );
    } finally {
      setBusy(false);
    }
  };
  const review = () =>
    perform(async () => {
      setPreview(
        await callResource("media-library", {
          action: "previewFolderStream",
          campaignId: idOf(campaign._id),
          profileId: profile.id,
          maxGrossUsd: Number(ceiling),
          batchSize: Number(batchSize),
        }),
      );
    });
  const confirm = () =>
    perform(async () => {
      const result = await callResource("media-library", {
        action: "confirmFolderStream",
        previewId: preview.previewId,
        consent: true,
      });
      onChange(result.campaign);
      setOpen(false);
      setPreview(undefined);
      toast.success("Local import and Google stream enabled");
    });
  const pause = () =>
    perform(async () => {
      const result = await callResource("media-library", {
        action: "pauseFolderStream",
        campaignId: idOf(campaign._id),
        confirm: true,
      });
      onChange(result.campaign);
    });

  if (!profile && !stream) return null;
  return (
    <div className="space-y-2 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        {stream && (
          <>
            <Badge variant="outline">
              Google · {String(stream.state).replaceAll("_", " ")}
            </Badge>
            <span className="text-xs">
              ${Number(stream.allocatedGrossUsd).toFixed(2)}{" "}
              / ${Number(stream.authorizedGrossUsd).toFixed(2)} allocated
            </span>
            <MediaHint label="About stream budget">
              Allocated is the sum of confirmed batch ceilings, not actual
              charges. Originals stay read-only. Each photo is sent once in this
              stream; retries require a new confirmation.
            </MediaHint>
          </>
        )}
        {stream?.state === "running"
          ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={pause}>
              Pause new batches
            </Button>
          )
          : (
            <Button
              size="sm"
              disabled={busy || !profile || campaign.status === "cancelled"}
              onClick={() => {
                setCeiling(String(stream?.authorizedGrossUsd ?? 50));
                setBatchSize(String(stream?.batchSize ?? 100));
                setPreview(undefined);
                setOpen(true);
              }}
            >
              {stream ? "Review & resume" : "Import + Google"}
            </Button>
          )}
        <a className="text-xs underline" href="/media/analysis">
          Photo analysis
        </a>
      </div>
      {stream?.safeError && (
        <p className="text-xs text-muted-foreground">{stream.safeError}</p>
      )}
      {stream?.counts?.total > 0 && (
        <p className="text-xs">
          Google · {stream.counts.ready ?? 0} ready / {stream.counts.total}{" "}
          sent · {stream.counts.failed ?? 0} failed
        </p>
      )}
      {stream?.nextCheckAt &&
        new Date(stream.nextCheckAt).getTime() > Date.now() + 60_000 &&
        (
          <p className="text-xs">
            Next budget check: {new Date(stream.nextCheckAt).toLocaleString()}
          </p>
        )}
      {(stream?.batches ?? []).slice(0, 1).map((batch: any) => (
        <p className="text-xs text-muted-foreground" key={idOf(batch._id)}>
          Latest batch · {batch.status} · ready{" "}
          {batch.counts?.ready ?? 0}/{batch.counts?.total ?? 0} · failed{" "}
          {batch.counts?.failed ?? 0}
        </p>
      ))}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import + Google stream</DialogTitle>
            <DialogDescription>
              Import this folder while discovery continues. Send newly available
              photos in bounded batches without waiting for the full archive.
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm">
            <code>{campaign.relativePath}</code>
            <br />
            {preview?.profileName ?? profile?.name}
          </div>
          {!preview
            ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="stream-ceiling">Total ceiling, USD</Label>
                    <Input
                      id="stream-ceiling"
                      type="number"
                      min="0.01"
                      max="300"
                      step="0.01"
                      value={ceiling}
                      onChange={(event) => setCeiling(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="stream-batch-size">Photos per batch</Label>
                    <Input
                      id="stream-batch-size"
                      type="number"
                      min="1"
                      max="500"
                      value={batchSize}
                      onChange={(event) => setBatchSize(event.target.value)}
                    />
                  </div>
                </div>
                <Button
                  disabled={busy || !profile || Number(ceiling) < 0.01 ||
                    Number(ceiling) > 300 ||
                    !Number.isInteger(Number(batchSize)) ||
                    Number(batchSize) < 1 || Number(batchSize) > 500}
                  onClick={review}
                >
                  Review cost
                </Button>
              </>
            )
            : (
              <>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <dt>Maximum total</dt>
                  <dd>${preview.authorizedGrossUsd.toFixed(2)}</dd>
                  <dt>Already allocated</dt>
                  <dd>${preview.allocatedGrossUsd.toFixed(2)}</dd>
                  <dt>Per photo / batch</dt>
                  <dd>
                    ${preview.perAssetGrossUsd} / up to {preview.batchSize}{" "}
                    photos
                  </dd>
                  <dt>Daily / monthly caps</dt>
                  <dd>
                    {preview.dailyGrossLimitUsd === null
                      ? "No daily limit"
                      : `$${preview.dailyGrossLimitUsd}`}{" "}
                    / ${preview.monthlyGrossLimitUsd}
                  </dd>
                  <dt>Project / location</dt>
                  <dd className="break-all">
                    {preview.projectId} / {preview.location}
                  </dd>
                </dl>
                <p className="text-sm">
                  Visual understanding + embedding and EU OCR. No global labels
                  or objects. Real charges may apply; credits are not subtracted
                  from these limits.
                </p>
                <p className="text-xs text-muted-foreground">
                  This authorization covers future photos discovered in this
                  folder, up to the total ceiling. Pause stops new batches;
                  confirmed batches finish. Local import continues
                  independently.
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setPreview(undefined)}
                  >
                    Back
                  </Button>
                  <Button disabled={busy} onClick={confirm}>
                    Confirm stream · max ${preview.authorizedGrossUsd.toFixed(
                      2,
                    )}
                  </Button>
                </div>
              </>
            )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
