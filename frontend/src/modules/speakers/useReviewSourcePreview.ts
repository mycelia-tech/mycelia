import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { callResource } from "@/lib/api";

export type ReviewSourceMode =
  | "all_matching"
  | "selected_recordings"
  | "timeline_range"
  | "diarization_generation";

export type ReviewSourcePayload = {
  sourceMode: ReviewSourceMode;
  targetProfileIds: string[];
  embeddingSpaceIds: string[];
  runIds: string[];
  recordingIds: string[];
  candidateMode: "reviewable" | "auto_matched";
  quality: { minDurationSeconds: number; deduplicateOverlaps: boolean };
  rangeMode: "fixed" | "all_before";
  start?: Date;
  end?: Date;
};

export type ReviewSourcePreview<TSegment> = {
  sourceMode: ReviewSourceMode;
  range: { start: Date | string; end: Date | string };
  embeddingSpaceIds: string[];
  runIds: string[];
  recordingIds: string[];
  scope: Omit<ReviewSourcePayload, "start" | "end"> & {
    start: Date | string;
    end: Date | string;
  };
  counts: {
    eligibleSegments: number;
    recordings: number;
    scannedSegments: number;
    capped: boolean;
  };
  qualityStats: {
    input: number;
    accepted: number;
    shortExcluded: number;
    duplicateExcluded: number;
  };
  recordings: Array<{
    id: string;
    name?: string | null;
    path?: string | null;
    eligibleSegments: number;
    start: Date | string;
    end: Date | string;
  }>;
  sampleSegments: TSegment[];
};

export function reviewSourceErrorMessage(error: unknown): string {
  if (
    error instanceof DOMException &&
    ["AbortError", "TimeoutError"].includes(error.name)
  ) {
    return "Preview stopped after 60 seconds. Try a shorter range or retry when Mongo is less busy.";
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  if (/MaxTimeMS|time limit|timed out/i.test(message)) {
    return "The bounded database scan reached its time limit. Retry, choose a shorter range, or wait for heavy diarization writes to finish.";
  }
  return message;
}

/** Owns the checked source snapshot, independently of the draft form and session creation. */
export function useReviewSourcePreview<TSegment>() {
  const [sourcePreview, setSourcePreview] = useState<
    ReviewSourcePreview<TSegment> | null
  >(null);
  const [previewedSourcePayload, setPreviewedSourcePayload] = useState<
    ReviewSourcePayload | null
  >(null);
  const [sourcePreviewDirty, setSourcePreviewDirty] = useState(true);
  const [status, setStatus] = useState<
    "idle" | "pending" | "success" | "error"
  >("idle");
  const [error, setError] = useState<unknown>(null);
  const [sourcePreviewElapsedSeconds, setSourcePreviewElapsedSeconds] =
    useState(0);
  const revision = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const invalidateSourcePreview = useCallback(() => {
    revision.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    setSourcePreviewDirty(true);
    setPreviewedSourcePayload(null);
    setStatus("idle");
    setError(null);
  }, []);
  const resetSourcePreview = useCallback(() => {
    invalidateSourcePreview();
    setSourcePreview(null);
  }, [invalidateSourcePreview]);

  const startPreview = useCallback(async (payload: ReviewSourcePayload) => {
    invalidateSourcePreview();
    const requestRevision = revision.current;
    const controller = new AbortController();
    activeRequest.current = controller;
    setStatus("pending");
    try {
      const preview = await callResource("speaker-segments", {
        action: "preview-review-session",
        ...payload,
        previewLimit: 5,
      }, {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(60_000),
        ]),
      }) as ReviewSourcePreview<TSegment>;
      if (requestRevision !== revision.current) return;
      setSourcePreview(preview);
      // The server resolves relative/all-before ranges. Start only this exact checked scope.
      setPreviewedSourcePayload({
        ...preview.scope,
        start: new Date(preview.scope.start),
        end: new Date(preview.scope.end),
      });
      setSourcePreviewDirty(false);
      setStatus("success");
    } catch (requestError) {
      if (requestRevision !== revision.current) return;
      setError(requestError);
      setStatus("error");
      toast.error("Could not preview review source", {
        description: reviewSourceErrorMessage(requestError),
      });
    } finally {
      if (requestRevision === revision.current) activeRequest.current = null;
    }
  }, [invalidateSourcePreview]);

  useEffect(() => {
    if (status !== "pending") {
      setSourcePreviewElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setSourcePreviewElapsedSeconds(0);
    const timer = globalThis.setInterval(() => {
      setSourcePreviewElapsedSeconds(
        Math.floor((Date.now() - startedAt) / 1_000),
      );
    }, 1_000);
    return () => globalThis.clearInterval(timer);
  }, [status]);

  useEffect(() => () => {
    revision.current += 1;
    activeRequest.current?.abort();
  }, []);

  return {
    sourcePreview,
    previewedSourcePayload,
    sourcePreviewDirty,
    sourcePreviewElapsedSeconds,
    previewReviewSource: {
      isPending: status === "pending",
      isError: status === "error",
      error,
    },
    startPreview,
    invalidateSourcePreview,
    resetSourcePreview,
  };
}
