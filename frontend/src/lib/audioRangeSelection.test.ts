import { describe, expect, it } from "vitest";
import { snapAudioRange } from "./audioRangeSelection";

describe("snapAudioRange", () => {
  it("clips overlapping audio bins to the displayed domain", () => {
    const minute = 60_000;
    const hour = 60 * minute;

    expect(snapAudioRange(
      [10 * hour + 15 * minute, 10 * hour + 45 * minute],
      [10 * hour + 5 * minute, 10 * hour + 55 * minute],
      [{ start: 10 * hour, end: 11 * hour }],
      minute,
    )).toEqual([10 * hour + 5 * minute, 10 * hour + 55 * minute]);
  });

  it("snaps to the nearest available start and finish", () => {
    expect(snapAudioRange(
      [70_000, 290_000],
      [0, 600_000],
      [{ start: 60_000, end: 120_000 }, { start: 240_000, end: 300_000 }],
      1_000,
    )).toEqual([60_000, 300_000]);
  });

  it("clamps the requested range when no audio bins are available", () => {
    expect(snapAudioRange([-10_000, 700_000], [0, 600_000], [], 1_000))
      .toEqual([0, 600_000]);
  });

  it.each([
    [{ start: 0, end: 50_000 }, { start: 150_000, end: 200_000 }],
    [{ start: 0, end: 100_000 }, { start: 100_000, end: 200_000 }],
  ])(
    "keeps the requested range when nearest snaps cross or coincide (%j, %j)",
    (first, second) => {
      expect(snapAudioRange(
        [80_000, 120_000],
        [0, 200_000],
        [first, second],
        1_000,
      )).toEqual([80_000, 120_000]);
    },
  );

  it("keeps the requested range when snapping would make it too short", () => {
    expect(snapAudioRange(
      [40_000, 160_000],
      [0, 200_000],
      [{ start: 90_000, end: 110_000 }],
      60_000,
    )).toEqual([40_000, 160_000]);
  });

  it("preserves one precision step at the upper domain boundary", () => {
    expect(snapAudioRange([199_000, 200_000], [0, 200_000], [], 60_000))
      .toEqual([140_000, 200_000]);
  });

  it("uses the whole domain when it is shorter than one precision step", () => {
    expect(snapAudioRange([1_000, 4_000], [0, 5_000], [], 60_000))
      .toEqual([0, 5_000]);
  });

  it("ignores audio outside the domain and invalid intervals", () => {
    expect(snapAudioRange(
      [40_000, 160_000],
      [0, 200_000],
      [
        { start: -100_000, end: -1 },
        { start: 200_000, end: 300_000 },
        { start: 100_000, end: 50_000 },
      ],
      1_000,
    )).toEqual([40_000, 160_000]);
  });

  it("preserves the untouched finish when the start thumb moves", () => {
    const minute = 60_000;
    const hour = 60 * minute;

    expect(snapAudioRange(
      [10 * hour + 20 * minute, 10 * hour + 55 * minute],
      [10 * hour + 5 * minute, 10 * hour + 55 * minute],
      [
        { start: 10 * hour + 15 * minute, end: 10 * hour + 30 * minute },
        { start: 10 * hour + 35 * minute, end: 10 * hour + 50 * minute },
      ],
      minute,
      [10 * hour + 5 * minute, 10 * hour + 55 * minute],
    )).toEqual([10 * hour + 15 * minute, 10 * hour + 55 * minute]);
  });

  it("preserves the untouched start when the finish thumb moves", () => {
    expect(snapAudioRange(
      [10_000, 160_000],
      [0, 200_000],
      [{ start: 50_000, end: 150_000 }],
      1_000,
      [10_000, 200_000],
    )).toEqual([10_000, 150_000]);
  });

  it.each([
    {
      next: [140_000, 160_000] as [number, number],
      previous: [20_000, 160_000] as [number, number],
      audio: { start: 170_000, end: 190_000 },
    },
    {
      next: [40_000, 60_000] as [number, number],
      previous: [40_000, 180_000] as [number, number],
      audio: { start: 0, end: 30_000 },
    },
  ])("keeps the request when a snap crosses the untouched edge (%j)", ({
    next,
    previous,
    audio,
  }) => {
    expect(snapAudioRange(next, [0, 200_000], [audio], 1_000, previous))
      .toEqual(next);
  });

  it.each([
    {
      next: [99_000, 100_000] as [number, number],
      previous: [0, 100_000] as [number, number],
      expected: [40_000, 100_000],
    },
    {
      next: [100_000, 101_000] as [number, number],
      previous: [100_000, 200_000] as [number, number],
      expected: [100_000, 160_000],
    },
  ])("enforces minimum duration by adjusting only the moving edge (%j)", ({
    next,
    previous,
    expected,
  }) => {
    expect(snapAudioRange(next, [0, 200_000], [], 60_000, previous))
      .toEqual(expected);
  });
});
