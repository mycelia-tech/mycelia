import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reviewSourceErrorMessage,
  type ReviewSourcePayload,
  type ReviewSourcePreview,
  useReviewSourcePreview,
} from "./useReviewSourcePreview";

const { callMock, toastError } = vi.hoisted(() => ({
  callMock: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ callResource: callMock }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const payload: ReviewSourcePayload = {
  sourceMode: "all_matching",
  targetProfileIds: ["fictional-profile"],
  embeddingSpaceIds: ["fixture-space"],
  runIds: [],
  recordingIds: [],
  candidateMode: "reviewable",
  quality: { minDurationSeconds: 1, deduplicateOverlaps: true },
  rangeMode: "all_before",
};
function preview(count = 4): ReviewSourcePreview<unknown> {
  const range = { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" };
  return {
    sourceMode: "all_matching",
    range,
    embeddingSpaceIds: ["fixture-space"],
    runIds: [],
    recordingIds: [],
    scope: { ...payload, rangeMode: "fixed", ...range },
    counts: {
      eligibleSegments: count,
      recordings: 1,
      scannedSegments: count,
      capped: false,
    },
    qualityStats: {
      input: count,
      accepted: count,
      shortExcluded: 0,
      duplicateExcluded: 0,
    },
    recordings: [],
    sampleSegments: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("voice review source snapshot", () => {
  it("uses the server-resolved checked scope and marks it stale when the draft changes", async () => {
    callMock.mockResolvedValue(preview());
    const hook = renderHook(() => useReviewSourcePreview());
    await act(() => hook.result.current.startPreview(payload));
    expect(callMock).toHaveBeenCalledWith("speaker-segments", {
      action: "preview-review-session",
      ...payload,
      previewLimit: 5,
    }, { signal: expect.any(AbortSignal) });
    expect(hook.result.current.previewedSourcePayload).toEqual({
      ...preview().scope,
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-02T00:00:00Z"),
    });
    expect(hook.result.current.sourcePreviewDirty).toBe(false);
    act(() => hook.result.current.invalidateSourcePreview());
    expect(hook.result.current.sourcePreviewDirty).toBe(true);
    expect(hook.result.current.previewedSourcePayload).toBeNull();
    expect(hook.result.current.sourcePreview?.counts.eligibleSegments).toBe(4);
  });

  it("cancels an obsolete preview and cannot replace a newer checked source with its late response", async () => {
    const oldRequest = deferred<ReviewSourcePreview<unknown>>();
    const newRequest = deferred<ReviewSourcePreview<unknown>>();
    callMock.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(
      newRequest.promise,
    );
    const hook = renderHook(() => useReviewSourcePreview());
    let oldCompletion!: Promise<void>;
    let newCompletion!: Promise<void>;
    act(() => {
      oldCompletion = hook.result.current.startPreview(payload);
    });
    const oldSignal = callMock.mock.calls[0][2].signal;
    act(() => {
      newCompletion = hook.result.current.startPreview({
        ...payload,
        recordingIds: ["new-source"],
      });
    });
    expect(oldSignal.aborted).toBe(true);
    await act(async () => {
      newRequest.resolve(preview(7));
      await newCompletion;
    });
    await act(async () => {
      oldRequest.resolve(preview(99));
      await oldCompletion;
    });
    expect(hook.result.current.sourcePreview?.counts.eligibleSegments).toBe(7);
    expect(hook.result.current.sourcePreviewDirty).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("clears a switched profile's snapshot and ignores its late error", async () => {
    const request = deferred<ReviewSourcePreview<unknown>>();
    callMock.mockReturnValue(request.promise);
    const hook = renderHook(() => useReviewSourcePreview());
    let completion!: Promise<void>;
    act(() => {
      completion = hook.result.current.startPreview(payload);
    });
    act(() => hook.result.current.resetSourcePreview());
    await act(async () => {
      request.reject(new Error("old profile failure"));
      await completion;
    });
    expect(hook.result.current.sourcePreview).toBeNull();
    expect(hook.result.current.previewedSourcePayload).toBeNull();
    expect(hook.result.current.previewReviewSource).toMatchObject({
      isPending: false,
      isError: false,
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("tracks pending elapsed time, resets it after an error, and aborts on unmount", async () => {
    vi.useFakeTimers();
    const first = deferred<ReviewSourcePreview<unknown>>();
    const second = deferred<ReviewSourcePreview<unknown>>();
    callMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(
      second.promise,
    );
    const hook = renderHook(() => useReviewSourcePreview());
    let completion!: Promise<void>;
    act(() => {
      completion = hook.result.current.startPreview(payload);
    });
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(hook.result.current.sourcePreviewElapsedSeconds).toBe(3);
    await act(async () => {
      first.reject(new DOMException("deadline", "TimeoutError"));
      await completion;
    });
    expect(hook.result.current.sourcePreviewElapsedSeconds).toBe(0);
    expect(hook.result.current.previewReviewSource.isError).toBe(true);
    expect(toastError).toHaveBeenCalledWith("Could not preview review source", {
      description: expect.stringContaining("60 seconds"),
    });
    act(() => {
      completion = hook.result.current.startPreview(payload);
    });
    const signal = callMock.mock.calls[1][2].signal;
    hook.unmount();
    expect(signal.aborted).toBe(true);
    second.reject(new Error("late unmount failure"));
    await completion;
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(reviewSourceErrorMessage(new Error("MaxTimeMS exceeded"))).toContain(
      "bounded database scan",
    );
  });
});
