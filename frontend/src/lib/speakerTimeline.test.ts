import { describe, expect, it } from "vitest";
import {
  buildSpeakerTimelineSummaryRequest,
  dominantSpeakerBucket,
  hasSpeakerTimelineData,
} from "./speakerTimeline";

describe("speaker timeline summary", () => {
  it("requests server buckets with explicit identity filters", () => {
    const start = new Date("2026-08-01T00:00:00.000Z");
    const end = new Date("2026-08-08T00:00:00.000Z");
    expect(buildSpeakerTimelineSummaryRequest({
      start,
      end,
      detail: "buckets",
      bucketMs: 60_000,
      filters: { states: ["identified"], validities: ["verified"] },
      profileId: "belka",
    })).toEqual({
      action: "speaker-timeline-summary",
      start,
      end,
      detail: "buckets",
      bucketMs: 60_000,
      filters: { states: ["identified"], validities: ["verified"] },
      profileId: "belka",
    });
  });

  it("uses backend-provided dominant state and validity", () => {
    expect(dominantSpeakerBucket({
      start: 0,
      end: 1,
      counts: { matched: 2, uncertain: 5 },
      dominantState: "matched",
      dominantValidity: "provisional",
    })).toEqual({ state: "matched", validity: "provisional" });
  });

  it("recognizes an explicit empty summary", () => {
    expect(hasSpeakerTimelineData({
      mode: "intervals",
      status: "no_data",
      intervals: [],
      totals: {
        segments: 0,
        matched: 0,
        rejected: 0,
        uncertain: 0,
        unclassified: 0,
      },
    })).toBe(false);
  });
});
