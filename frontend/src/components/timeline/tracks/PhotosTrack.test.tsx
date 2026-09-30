import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { scaleTime, zoomIdentity } from "d3";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { useTimelineRange } from "@/stores/timelineRange";
import {
  groupTimelinePhotoMarkers,
  photoDensityBucketEnd,
  PhotosTrack,
} from "./PhotosTrack";
import type { PhotoTimelineFocus } from "@/lib/photoTimelineDeepLink";

vi.mock("@/lib/api", () => ({ callResource: vi.fn() }));
vi.mock("@/components/media/AuthenticatedMediaImage", () => ({
  AuthenticatedMediaImage: ({ alt }: { alt: string }) => <span>{alt}</span>,
}));
vi.mock("@/components/media/PhotoCollectionSheet", () => ({
  PhotoCollectionSheet: (props: any) =>
    props.open
      ? (
        <aside aria-label={props.title}>
          <div>{props.description}</div>
          <div data-testid="sheet-total">{props.total}</div>
          {props.items.map((item: any) => (
            <div key={item.assetId}>{item.fileName}</div>
          ))}
          {props.hasMore && (
            <button type="button" onClick={props.onLoadMore}>Load more</button>
          )}
          <button
            type="button"
            aria-label="Close photo list"
            onClick={() => props.onOpenChange(false)}
          >
            Close
          </button>
        </aside>
      )
      : null,
}));

const mockCallResource = vi.mocked(api.callResource);
const START = new Date("2026-08-01T00:00:00.000Z");
const END = new Date("2026-08-03T00:00:00.000Z");

function renderTrack(options: {
  focusedPhoto?: PhotoTimelineFocus;
  onFocusedPhotoDismiss?: () => void;
} = {}) {
  const scale = scaleTime().domain([START, END]).range([0, 600]);
  return render(
    <MemoryRouter>
      <PhotosTrack
        scale={scale}
        transform={zoomIdentity}
        width={600}
        height={48}
        focusedPhoto={options.focusedPhoto}
        onFocusedPhotoDismiss={options.onFocusedPhotoDismiss}
      />
    </MemoryRouter>,
  );
}

describe("PhotosTrack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTimelineRange.getState().setRange(START, END);
  });

  it("groups overlapping markers and opens every photo with the keyboard", async () => {
    mockCallResource.mockResolvedValue({
      mode: "items",
      total: 3,
      unplacedTimeCount: 0,
      items: [
        {
          assetId: "photo-1",
          fileName: "one.jpg",
          status: "ready",
          capturedAt: "2026-08-01T10:00:00.000Z",
        },
        {
          assetId: "photo-2",
          fileName: "two.jpg",
          status: "staged",
          capturedAt: "2026-08-01T10:01:00.000Z",
        },
        {
          assetId: "photo-3",
          fileName: "three.jpg",
          status: "ready",
          capturedAt: "2026-08-02T10:00:00.000Z",
        },
      ],
    });

    renderTrack();
    const grouped = await screen.findByRole("button", {
      name: "Open 2 nearby photos",
    });
    expect(grouped.getAttribute("tabindex")).toBe("0");
    expect(grouped.getAttribute("class")).toContain("focus-visible:outline-2");
    expect(grouped.getAttribute("class")).not.toContain("outline-none");
    grouped.focus();
    fireEvent.keyDown(grouped, { key: "Enter" });

    const sheet = screen.getByRole("complementary", {
      name: "2 nearby photos",
    });
    expect(sheet).toBeTruthy();
    expect(within(sheet).getByText("one.jpg")).toBeTruthy();
    expect(within(sheet).getByText("two.jpg")).toBeTruthy();
    expect(screen.getByTestId("sheet-total").textContent).toBe("2");
    expect(screen.getByRole("button", {
      name: "Open photo three.jpg",
    })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close photo list" }));
    await waitFor(() => expect(document.activeElement).toBe(grouped));
  });

  it("opens a density bucket with an exact UTC range and cursor pages", async () => {
    mockCallResource.mockImplementation((resource, input) => {
      if (resource === "media-library" && input.action === "timeline") {
        return Promise.resolve({
          mode: "density",
          total: 120,
          unplacedTimeCount: 0,
          resolution: "day",
          buckets: [{
            start: "2026-08-01T00:00:00.000Z",
            count: 120,
            statuses: { ready: 120 },
          }],
        });
      }
      if (resource === "media" && input.action === "listAssets") {
        if (input.cursor) {
          return Promise.resolve({
            assets: [{
              _id: "photo-2",
              fileName: "two.jpg",
              status: "ready",
              capturedAt: "2026-08-01T20:00:00.000Z",
            }],
            total: 120,
          });
        }
        return Promise.resolve({
          assets: [{
            _id: "photo-1",
            fileName: "one.jpg",
            status: "ready",
            capturedAt: "2026-08-01T10:00:00.000Z",
          }],
          total: 120,
          nextCursor: "next-page",
        });
      }
      return Promise.resolve({});
    });

    renderTrack();
    const bucket = await screen.findByRole("button", {
      name: /Open 120 photos from/,
    });
    expect(bucket.getAttribute("class")).toContain("focus-visible:outline-2");
    expect(bucket.getAttribute("class")).not.toContain("outline-none");
    fireEvent.keyDown(bucket, { key: " " });
    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith("media", {
        action: "listAssets",
        kind: "image",
        inventoryFilter: "all",
        placement: "all",
        capturedFrom: "2026-08-01T00:00:00.000Z",
        capturedTo: "2026-08-01T23:59:59.999Z",
        limit: 100,
      });
    });
    expect(await screen.findByText("one.jpg")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith(
        "media",
        expect.objectContaining({ cursor: "next-page", limit: 100 }),
      );
    });
    expect(await screen.findByText("two.jpg")).toBeTruthy();
  });

  it("ignores an older Timeline response after the visible range changes", async () => {
    let resolveOld: (value: unknown) => void = () => {};
    const oldResponse = new Promise((resolve) => {
      resolveOld = resolve;
    });
    let timelineCalls = 0;
    mockCallResource.mockImplementation((resource, input) => {
      if (resource !== "media-library" || input.action !== "timeline") {
        return Promise.resolve({});
      }
      timelineCalls += 1;
      if (timelineCalls === 1) return oldResponse;
      return Promise.resolve({
        mode: "items",
        total: 1,
        unplacedTimeCount: 0,
        items: [{
          assetId: "new-photo",
          fileName: "new.jpg",
          status: "ready",
          capturedAt: "2026-08-01T10:00:00.000Z",
        }],
      });
    });

    renderTrack();
    await waitFor(() => expect(timelineCalls).toBe(1));
    act(() => {
      useTimelineRange.getState().setRange(
        new Date("2026-07-01T00:00:00.000Z"),
        new Date("2026-07-03T00:00:00.000Z"),
      );
    });
    expect(await screen.findByRole("button", { name: "Open photo new.jpg" }))
      .toBeTruthy();

    await act(async () => {
      resolveOld({
        mode: "items",
        total: 1,
        unplacedTimeCount: 0,
        items: [{
          assetId: "old-photo",
          fileName: "old.jpg",
          status: "ready",
          capturedAt: "2026-08-01T10:00:00.000Z",
        }],
      });
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Open photo old.jpg" }))
      .toBeNull();
    expect(screen.getByRole("button", { name: "Open photo new.jpg" }))
      .toBeTruthy();
  });

  it("opens a deep-linked unplaced photo without inventing a capture time", async () => {
    mockCallResource.mockResolvedValue({
      mode: "items",
      total: 0,
      unplacedTimeCount: 1,
      items: [],
    });
    const onFocusedPhotoDismiss = vi.fn();

    renderTrack({
      focusedPhoto: {
        item: {
          assetId: "unplaced-photo",
          fileName: "unplaced.jpg",
          status: "staged",
          capturedAt: null,
          shortCaption: "A photo without EXIF time",
        },
      },
      onFocusedPhotoDismiss,
    });

    const sheet = await screen.findByRole("complementary", {
      name: "unplaced.jpg",
    });
    expect(within(sheet).getByText("unplaced.jpg")).toBeTruthy();
    expect(within(sheet).getByText(/Missing capture time/)).toBeTruthy();
    expect(within(sheet).getByText(/cannot appear on the Timeline/))
      .toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close photo list" }));
    expect(onFocusedPhotoDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("photo Timeline helpers", () => {
  it("uses connected pixel overlap groups without dropping equal timestamps", () => {
    const items = ["one", "two", "three"].map((assetId, index) => ({
      assetId,
      fileName: `${assetId}.jpg`,
      status: "ready",
      capturedAt: new Date(index * 10),
    }));
    const groups = groupTimelinePhotoMarkers(
      items,
      (date) => date.getTime(),
      100,
      15,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((item) => item.assetId)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("derives hour, day, and calendar-month UTC bucket ends", () => {
    expect(
      photoDensityBucketEnd("2026-08-01T10:00:00.000Z", "hour")
        ?.toISOString(),
    ).toBe("2026-08-01T11:00:00.000Z");
    expect(
      photoDensityBucketEnd("2026-08-01T00:00:00.000Z", "day")
        ?.toISOString(),
    ).toBe("2026-08-02T00:00:00.000Z");
    expect(
      photoDensityBucketEnd("2026-01-01T00:00:00.000Z", "month")
        ?.toISOString(),
    ).toBe("2026-02-01T00:00:00.000Z");
  });
});
