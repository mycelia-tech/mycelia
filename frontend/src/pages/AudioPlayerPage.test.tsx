import { act, fireEvent, render, screen } from "@testing-library/react";
import * as userEventLib from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createJSONStorage } from "zustand/middleware";
import AudioPlayerPage from "./AudioPlayerPage";
import { useAudioPlayer } from "@/modules/audio/player";
import { useSettingsStore } from "@/stores/settingsStore";

const userEvent = (userEventLib as any).default || userEventLib;

describe("AudioPlayerPage date selection", () => {
  beforeEach(() => {
    const settingsStorage = new Map<string, string>();
    useSettingsStore.persist.setOptions({
      storage: createJSONStorage(() => ({
        getItem: (key) => settingsStorage.get(key) ?? null,
        setItem: (key, value) => {
          settingsStorage.set(key, value);
        },
        removeItem: (key) => {
          settingsStorage.delete(key);
        },
      })),
    });
    // The playback engine is not mounted; the real store has no audio resources.
    useAudioPlayer.setState({
      currentDate: new Date("2026-08-24T10:00:00Z"),
      startDate: null,
      seekTarget: null,
      seekGeneration: 0,
      isPlaying: false,
      chunks: [],
      currentChunk: null,
      audioContext: null,
      sourceNode: null,
      gainNode: null,
      rafId: null,
      baselineStartDate: null,
      baselineStartCtxTime: null,
      isCreatingSource: false,
    });
    useSettingsStore.setState({
      defaultTimeZone: "UTC",
      volume: 1,
      playbackRate: 1,
    });
  });

  it.each([false, true])(
    "seeks immediately when Apply is pressed with playing=%s",
    async (isPlaying) => {
      const user = userEvent.setup();
      useAudioPlayer.setState({ isPlaying });
      render(<AudioPlayerPage />);
      await user.click(screen.getByRole("button", { name: /Aug 24, 2026/ }));
      fireEvent.change(screen.getByLabelText("Time"), {
        target: { value: "12:30" },
      });

      await user.click(screen.getByRole("button", { name: "Apply" }));

      const state = useAudioPlayer.getState();
      expect(state.currentDate?.toISOString()).toBe("2026-08-24T12:30:00.000Z");
      expect(state.seekTarget?.toISOString()).toBe("2026-08-24T12:30:00.000Z");
      expect(state.seekGeneration).toBe(1);
      expect(state.isPlaying).toBe(isPlaying);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      if (!isPlaying) {
        await user.click(screen.getByRole("button", { name: "" }));
        expect(useAudioPlayer.getState().isPlaying).toBe(true);
        expect(useAudioPlayer.getState().seekGeneration).toBe(1);
      }
    },
  );

  it.each([false, true])(
    "does not seek on Cancel with playing=%s",
    async (isPlaying) => {
      const user = userEvent.setup();
      useAudioPlayer.setState({ isPlaying });
      render(<AudioPlayerPage />);
      await user.click(screen.getByRole("button", { name: /Aug 24, 2026/ }));
      fireEvent.change(screen.getByLabelText("Time"), {
        target: { value: "12:30" },
      });

      await user.click(screen.getByRole("button", { name: "Cancel" }));

      const state = useAudioPlayer.getState();
      expect(state.currentDate?.toISOString()).toBe("2026-08-24T10:00:00.000Z");
      expect(state.seekTarget).toBeNull();
      expect(state.seekGeneration).toBe(0);
      expect(state.isPlaying).toBe(isPlaying);
    },
  );

  it("continues displaying playback updates without issuing a seek", () => {
    useAudioPlayer.setState({ isPlaying: true });
    render(<AudioPlayerPage />);

    act(() => {
      useAudioPlayer.getState().updateDate(new Date("2026-08-24T10:01:00Z"));
    });

    expect(screen.getByRole("button", { name: /Aug 24, 2026, 10:01 AM/ }))
      .toBeInTheDocument();
    expect(useAudioPlayer.getState().seekGeneration).toBe(0);
  });

  it("initializes the playback date on the first Play when no position exists", async () => {
    const user = userEvent.setup();
    useAudioPlayer.setState({ currentDate: null });
    const before = Date.now();
    render(<AudioPlayerPage />);

    await user.click(screen.getByRole("button", { name: "" }));

    const state = useAudioPlayer.getState();
    expect(state.currentDate?.getTime()).toBeGreaterThanOrEqual(before);
    expect(state.currentDate?.getTime()).toBeLessThanOrEqual(Date.now());
    expect(state.seekTarget).toEqual(state.currentDate);
    expect(state.seekGeneration).toBe(1);
    expect(state.isPlaying).toBe(true);
  });
});
