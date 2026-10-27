import { describe, expect, it } from "vitest";
import {
  getMaximumAudioHours,
  MAX_AUDIO_CHUNK_SECONDS,
  normalizeAudioSourceFileStats,
} from "./audioPipelineStats";

describe("getMaximumAudioHours", () => {
  it("matches the STT CLI estimate for 10-second chunks", () => {
    expect(MAX_AUDIO_CHUNK_SECONDS).toBe(10);
    expect(getMaximumAudioHours(5422)).toBeCloseTo(15.06, 2);
  });

  it("does not return negative work estimates", () => {
    expect(getMaximumAudioHours(-12)).toBe(0);
  });
});

describe("normalizeAudioSourceFileStats", () => {
  it("keeps the pipeline page compatible with responses from an older backend", () => {
    expect(normalizeAudioSourceFileStats(undefined, 13)).toEqual({
      total: 13,
      ingested: 0,
      blocked: 0,
      pending: 0,
      errors: 0,
      byKind: [],
    });
  });
});
