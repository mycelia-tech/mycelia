import { useEffect, useState } from "react";
import { callResource } from "@/lib/api";
import { Button } from "@/components/ui/button";

/** Stored results only: opening history never sends an image to a provider. */
export function MediaResultPanel({ detail }: { detail: any }) {
  const [tab, setTab] = useState("Description");
  const [runId, setRunId] = useState("");
  const [history, setHistory] = useState<any>();
  const [error, setError] = useState("");
  const assetId = String(detail.asset._id);
  useEffect(() => {
    setRunId("");
    setHistory(undefined);
    setTab("Description");
  }, [assetId]);
  useEffect(() => {
    let cancelled = false;
    setHistory(undefined);
    setError("");
    if (runId) {
      callResource("media", { action: "getAnalysisRun", assetId, runId }).then(
        (result) => {
          if (!cancelled) {
            setHistory(result);
          }
        },
      ).catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [assetId, runId]);
  const result = runId ? history : detail;
  const run = runId
    ? history?.run
    : detail.runs?.find((entry: any) =>
      String(entry._id) === String(detail.asset.currentRunId)
    );
  const visual = result?.visual?.visualUnderstanding;
  return (
    <section
      className="space-y-3 rounded-lg border p-3"
      aria-label="Stored analysis results"
    >
      <div
        className="flex flex-wrap gap-1"
        role="tablist"
        aria-label="Result sections"
      >
        {["Description", "Text", "Metadata", "History"].map((name) => (
          <Button
            key={name}
            size="sm"
            variant={tab === name ? "secondary" : "ghost"}
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
          >
            {name}
          </Button>
        ))}
      </div>
      {run && (
        <p className="text-xs text-muted-foreground">
          {run.providerSnapshot?.name ?? run.provenance?.providerType} ·{" "}
          {run.provenance?.modelVersion ?? run.providerSnapshot?.model ??
            "Model not reported"} · {run.completedAt
            ? new Date(run.completedAt).toLocaleString()
            : run.state}
        </p>
      )}
      {runId && (
        <div className="flex items-center gap-2 text-sm">
          <span>Historical version</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRunId("")}
          >
            Back to current
          </Button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}
      </p>}
      {runId && !history && !error
        ? <p role="status">Loading stored version…</p>
        : (
          <>
            {tab === "Description" && (
              <div className="space-y-2">
                <h3 className="font-medium">
                  {visual?.shortCaption ?? "No description yet"}
                </h3>
                <p className="whitespace-pre-wrap text-sm">
                  {visual?.description}
                </p>
                {visual && (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-muted-foreground">
                      Scene, objects & confidence
                    </summary>
                    <p className="mt-2">
                      {visual.scene?.summary} · {visual.peopleCount ?? 0} people
                    </p>
                    <p>
                      {(visual.objects ?? []).map((item: any) => item.name)
                        .join(" · ")}
                    </p>
                    <p>
                      {(visual.activities ?? []).map((item: any) =>
                        item.description
                      ).join(" · ")}
                    </p>
                    <p>
                      {visual.possibleEvent} ·{" "}
                      {Math.round((visual.confidence ?? 0) * 100)}% confidence
                    </p>
                    {visual.warnings?.length > 0 && (
                      <p className="text-amber-700">
                        {visual.warnings.join(" · ")}
                      </p>
                    )}
                  </details>
                )}
                {visual?.keywords?.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {visual.keywords.join(" · ")}
                  </p>
                )}
              </div>
            )}
            {tab === "Text" && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  {run?.providerSnapshot?.providerType === "openai-compatible"
                    ? "Model-extracted text — not dedicated OCR"
                    : "OCR text"}
                </p>
                {(result?.pages ?? []).map((page: any) => (
                  <p
                    className="whitespace-pre-wrap text-sm"
                    key={page.pageNumber}
                  >
                    {page.text || "No text detected"}
                  </p>
                ))}
                {!result?.pages?.length && (
                  <p className="text-sm">No extracted text</p>
                )}
              </div>
            )}
            {tab === "Metadata" && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt>Captured</dt>
                <dd>
                  {detail.asset.capturedAt
                    ? new Date(detail.asset.capturedAt).toLocaleString()
                    : "Unknown"}
                </dd>
                <dt>Location</dt>
                <dd>
                  {detail.asset.location
                    ? `${detail.asset.location.latitude}, ${detail.asset.location.longitude}`
                    : "Unknown"}
                </dd>
                <dt>Input / output tokens</dt>
                <dd>
                  {run?.usage
                    ? `${run.usage.inputTokens ?? "—"} / ${
                      run.usage.outputTokens ?? "—"
                    }`
                    : "Not reported"}
                </dd>
                <dt>Cost</dt>
                <dd>
                  {typeof run?.usage?.grossListPriceUsd === "number"
                    ? `$${run.usage.grossListPriceUsd.toFixed(6)}`
                    : "Unknown"}
                </dd>
              </dl>
            )}
            {tab === "History" && (
              <div className="space-y-2">
                {!(detail.runs?.length) && (
                  <p className="text-sm">No analysis runs yet</p>
                )}
                {(detail.runs ?? []).map((entry: any) => (
                  <div
                    key={String(entry._id)}
                    className="flex items-center justify-between gap-3 rounded border p-2 text-sm"
                  >
                    <div>
                      <p>
                        {entry.providerSnapshot?.name ?? "Provider"} ·{" "}
                        {entry.provenance?.modelVersion ??
                          entry.providerSnapshot?.model ?? ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {entry.createdAt
                          ? new Date(entry.createdAt).toLocaleString()
                          : ""} · {entry.state}
                        {String(entry._id) === String(detail.asset.currentRunId)
                          ? " · current"
                          : ""}
                      </p>
                      {entry.safeError && (
                        <p className="text-xs text-destructive">
                          {entry.safeError}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setRunId(String(entry._id));
                        setTab("Description");
                      }}
                    >
                      View version
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
    </section>
  );
}
