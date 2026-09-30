// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  queueSummaryRerunRange,
  queueSummaryRerunSelection,
  summaryDateBounds,
} from "./summaryRerun";

describe("latest summary reruns", () => {
  it("queues only the displayed conversations, deduplicated across summary versions", async () => {
    const ids = Array.from(
      { length: 250 },
      (_, i) => (i + 1).toString(16).padStart(24, "0"),
    );
    const call = vi.fn().mockResolvedValue({
      queued: [{}],
      nextCursor: ids[99],
    });
    await queueSummaryRerunSelection(
      {
        artifactIds: [...ids.map((id) => `${id}:0`), `${ids[0]}:1`],
        targetModel: "qwen3.8-27b-uncensored",
        targetProviderProfileId: "qwen-unc",
      },
      call,
      () => {},
    );
    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls.map(([request]) => request.artifactIds.length))
      .toEqual([100, 100, 50]);
    expect(call.mock.calls.flatMap(([request]) => request.artifactIds)).toEqual(
      ids,
    );
    for (const [request] of call.mock.calls) {
      expect(request).not.toHaveProperty("start");
      expect(request).not.toHaveProperty("afterObjectId");
      expect(request.targetProviderProfileId).toBe("qwen-unc");
    }
  });

  it("never submits an empty selection as an unrestricted rerun", async () => {
    const call = vi.fn();
    await expect(
      queueSummaryRerunSelection(
        { artifactIds: [], targetModel: "new" },
        call,
        () => {},
      ),
    )
      .rejects.toThrow("No summaries selected");
    expect(call).not.toHaveBeenCalled();
  });
});

describe("summary rerun range", () => {
  it("uses inclusive calendar dates in the selected timezone", () => {
    expect(summaryDateBounds("2026-08-24", "2026-08-30", "Asia/Yerevan"))
      .toEqual({
        start: "2026-08-23T20:00:00.000Z",
        end: "2026-08-30T20:00:00.000Z",
      });
    expect(summaryDateBounds("2026-03-08", "2026-03-08", "America/New_York"))
      .toEqual({
        start: "2026-03-08T05:00:00.000Z",
        end: "2026-03-09T04:00:00.000Z",
      });
    expect(summaryDateBounds("", "2026-08-30", "UTC")).toBeNull();
    expect(summaryDateBounds("2026-08-31", "2026-08-30", "UTC")).toBeNull();
  });

  it("continues beyond 100, including a batch entirely already queued", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({
        queued: Array(100).fill({}),
        nextCursor: "000000000000000000000100",
      })
      .mockResolvedValueOnce({
        queued: [],
        skippedAlreadyQueued: 100,
        nextCursor: "000000000000000000000200",
      })
      .mockResolvedValueOnce({ queued: [{}, {}], nextCursor: null });
    const request = {
      start: "2026-08-24T00:00:00Z",
      end: "2026-08-31T00:00:00Z",
      targetModel: "qwen-unc",
      targetProviderProfileId: "local",
    };
    expect(await queueSummaryRerunRange(request, call, () => {}))
      .toEqual({ queued: 102, skipped: 100 });
    expect(call).toHaveBeenCalledTimes(3);
    for (const [input] of call.mock.calls) {
      expect(input).toMatchObject({ ...request, limit: 100 });
      expect(input).not.toHaveProperty("sourceModel");
    }
    expect(call.mock.calls[2][0].afterObjectId).toBe(
      "000000000000000000000200",
    );
  });

  it("stops on failure without silently reporting completion", async () => {
    const call = vi.fn().mockRejectedValue(new Error("unavailable"));
    await expect(queueSummaryRerunRange(
      {
        start: "2026-08-24T00:00:00Z",
        end: "2026-08-31T00:00:00Z",
        targetModel: "qwen-unc",
      },
      call,
      () => {},
    )).rejects.toThrow("unavailable");
    expect(call).toHaveBeenCalledTimes(1);
  });
});
