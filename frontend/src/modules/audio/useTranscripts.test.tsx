import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { callResource } from "@/lib/api";
import { resetTranscriptCache, useTranscripts } from "./useTranscripts";

vi.mock("@/lib/api", () => ({ callResource: vi.fn() }));
beforeEach(() => {
  resetTranscriptCache();
  vi.mocked(callResource).mockReset();
});

it("clears all mounted transcript views and ignores a late old-session response", async () => {
  const date = new Date("2026-01-01T12:00:00Z");
  const rows = [{ _id: "private", start: date, end: date, segments: [] }];
  vi.mocked(callResource).mockResolvedValueOnce(rows);
  const first = renderHook(({ date }) => useTranscripts(date), {
    initialProps: { date },
  });
  const second = renderHook(() => useTranscripts(date));
  await waitFor(() => expect(first.result.current.transcripts).toEqual(rows));
  expect(second.result.current.transcripts).toEqual(rows);
  expect(callResource).toHaveBeenCalledTimes(1);
  let resolve!: (value: typeof rows) => void;
  vi.mocked(callResource).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  first.rerender({ date: new Date(date.getTime() + 10_000) });
  const signal = vi.mocked(callResource).mock.calls[1][2]!.signal!;
  act(() => resetTranscriptCache());
  expect(signal.aborted).toBe(true);
  await act(async () => {
    resolve(rows);
    await Promise.resolve();
  });
  expect(first.result.current.transcripts).toEqual([]);
  expect(second.result.current.transcripts).toEqual([]);
  const next = renderHook(() => useTranscripts(null));
  expect(next.result.current.transcripts).toEqual([]);
});
