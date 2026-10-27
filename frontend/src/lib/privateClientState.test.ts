import { beforeEach, expect, it, vi } from "vitest";
import { resetPrivateClientState } from "./privateClientState";
import { queryClient } from "./queryClient";
import { useHistogramCache } from "@/modules/histogram/useHistogramCache";
import { useAudioPlayer } from "@/modules/audio/player";
import { useAudioPlaybackStore } from "@/stores/audioPlaybackStore";
import { useNotificationStore } from "@/stores/notificationStore";
import { useTopicsStore } from "@/stores/topicsStore";
import { callResource } from "@/lib/api";

vi.mock("@/lib/api", () => ({ callResource: vi.fn(), apiClient: {} }));
beforeEach(() => {
  resetPrivateClientState();
  vi.mocked(callResource).mockReset();
});

it("purges queries, histogram bins, persisted notifications, and all audio playback", () => {
  queryClient.setQueryData(["private"], "old-account");
  useHistogramCache.setState({
    data: { "5min": { items: [], loadedRanges: [{ start: 0, end: 300_000 }] } },
  });
  const histogramGeneration = useHistogramCache.getState().generation;
  const audioGeneration = useAudioPlayer.getState().seekGeneration;
  useNotificationStore.getState().addNotification({
    type: "info",
    title: "private",
  });
  const stop = vi.fn();
  useAudioPlaybackStore.getState().acquire("clip", stop);
  useAudioPlayer.setState({ currentDate: new Date(), isPlaying: true });
  resetPrivateClientState();
  expect(queryClient.getQueryCache().getAll()).toEqual([]);
  expect(useHistogramCache.getState().data).toEqual({});
  expect(useHistogramCache.getState().generation).toBeGreaterThan(
    histogramGeneration,
  );
  expect(useAudioPlayer.getState()).toMatchObject({
    isPlaying: false,
    chunks: [],
    currentDate: null,
  });
  expect(useAudioPlayer.getState().seekGeneration).toBeGreaterThan(
    audioGeneration,
  );
  expect(stop).toHaveBeenCalled();
  expect(useNotificationStore.getState().notifications).toEqual([]);
  expect(
    JSON.parse(localStorage.getItem("mycelia-notifications")!).state
      .notifications,
  ).toEqual([]);
});

it("ignores topic results from an account cleared while the request was pending", async () => {
  let resolve!: (rows: unknown[]) => void;
  vi.mocked(callResource).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = useTopicsStore.getState().fetchInitial();
  resetPrivateClientState();
  resolve([{ _id: "private", start: new Date(), topics: ["private"] }]);
  await pending;
  expect(useTopicsStore.getState()).toMatchObject({
    items: [],
    loading: false,
    loadingMore: false,
  });
});
