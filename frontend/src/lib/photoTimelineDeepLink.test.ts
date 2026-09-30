import { describe, expect, it } from "vitest";
import {
  getPhotoTimelineFocusRange,
  PHOTO_TIMELINE_FOCUS_WINDOW_MS,
  photoTimelineFocusFromAssetDetail,
} from "./photoTimelineDeepLink";

describe("photo Timeline deep links", () => {
  it("projects the owner-scoped detail response into one focused photo", () => {
    const focus = photoTimelineFocusFromAssetDetail({
      asset: {
        _id: "ABC123",
        kind: "image",
        fileName: "photo.jpg",
        status: "ready",
        capturedAt: "2026-08-12T11:22:33.000Z",
        thumbnailUrl: "/api/files/thumb",
        location: { latitude: 40.1, longitude: 44.5 },
      },
      visual: {
        visualUnderstanding: { shortCaption: "Two people near a lake" },
      },
    }, "abc123");

    expect(focus.item).toMatchObject({
      assetId: "ABC123",
      fileName: "photo.jpg",
      status: "ready",
      shortCaption: "Two people near a lake",
      location: { latitude: 40.1, longitude: 44.5 },
    });
    expect(focus.capturedAt?.toISOString()).toBe(
      "2026-08-12T11:22:33.000Z",
    );
  });

  it("keeps a missing or invalid capture time unplaced", () => {
    const focus = photoTimelineFocusFromAssetDetail({
      asset: {
        _id: "asset-1",
        kind: "image",
        fileName: "unplaced.jpg",
        capturedAt: "not-a-date",
      },
    }, "asset-1");

    expect(focus.capturedAt).toBeUndefined();
    expect(focus.item.capturedAt).toBeNull();
  });

  it("rejects a mismatched detail response", () => {
    expect(() =>
      photoTimelineFocusFromAssetDetail({
        asset: { _id: "another-asset" },
      }, "requested-asset")
    ).toThrow("requested photo was not returned");
  });

  it("rejects a non-image asset from a direct photo deep link", () => {
    expect(() =>
      photoTimelineFocusFromAssetDetail({
        asset: {
          _id: "document-1",
          kind: "pdf",
          fileName: "scan.pdf",
          capturedAt: "2026-08-12T11:22:33.000Z",
        },
      }, "document-1")
    ).toThrow("Only photo assets can be opened on the Timeline");
  });

  it("uses a bounded ten-minute range centered on capture time", () => {
    const capturedAt = new Date("2026-08-12T11:22:33.000Z");
    const range = getPhotoTimelineFocusRange(capturedAt);

    expect(range.end.getTime() - range.start.getTime()).toBe(
      PHOTO_TIMELINE_FOCUS_WINDOW_MS,
    );
    expect((range.start.getTime() + range.end.getTime()) / 2).toBe(
      capturedAt.getTime(),
    );
  });
});
