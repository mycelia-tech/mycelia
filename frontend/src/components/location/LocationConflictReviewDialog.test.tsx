// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { callResource } from "@/lib/api";
import { LocationConflictReviewDialog } from "./LocationConflictReviewDialog";

vi.mock("@/lib/api", () => ({ callResource: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("moves a deferred row to Later and applies bulk choices only after confirmation", async () => {
  const rows = ["July track", "August track", "September track"].map((
    name,
    index,
  ) => ({
    _id: String(index),
    entityType: "track",
    field: "name",
    existingValue: name,
    incomingValue: "Location Track",
    incomingFormat: "gpx",
    defaultSelection: "existing",
    status: "pending",
    resolution: undefined as string | undefined,
  }));
  const writes: Array<{ id: string; resolution: string }> = [];
  vi.mocked(callResource).mockImplementation((_resource, request) => {
    if (request.action === "list-metadata-conflicts") {
      const conflicts = rows.filter(({ status, resolution }) =>
        request.status === "deferred"
          ? resolution === "defer"
          : request.status === status && resolution !== "defer"
      );
      return Promise.resolve({ conflicts, total: conflicts.length });
    }
    if (request.action === "resolve-metadata-conflict") {
      const row = rows.find(({ _id }) => _id === request.id)!;
      row.resolution = request.resolution;
      if (request.resolution !== "defer") row.status = "resolved";
      writes.push({ id: request.id, resolution: request.resolution });
      return Promise.resolve({ success: true });
    }
    return Promise.resolve({ conflicts: [], total: 0 });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LocationConflictReviewDialog
        open
        onOpenChange={vi.fn()}
        gapDistanceM={100}
        gapMinutes={2}
      />
    </QueryClientProvider>,
  );
  await screen.findByText("July track");
  fireEvent.click(screen.getAllByRole("button", { name: "Compare" })[0]);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Apply decision" })
      .disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: /Incoming.*Location Track/ }),
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Apply decision" })
      .disabled,
  ).toBe(false);
  expect(writes).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Close comparison" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Decide later" })[0]);
  await screen.findByText("Moved to Later.");
  expect(screen.queryByText("July track")).toBeNull();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Later" }), {
    button: 0,
  });
  expect(await screen.findByText("July track")).toBeTruthy();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "To review" }), {
    button: 0,
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Keep current for 2" }),
  );
  expect(writes).toEqual([{ id: "0", resolution: "defer" }]);
  fireEvent.click(screen.getByRole("button", { name: "Apply 2 decisions" }));
  await screen.findByText("Applied 2 decisions. See Applied for details.");
  expect(writes.slice(1)).toEqual([
    { id: "1", resolution: "keep_existing" },
    { id: "2", resolution: "keep_existing" },
  ]);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Applied" }), {
    button: 0,
  });
  await waitFor(() =>
    expect(screen.getAllByText("Current kept")).toHaveLength(2)
  );
});

it("applies the matching track ID when the earlier import is stored second", async () => {
  const writes: string[] = [];
  vi.mocked(callResource).mockImplementation((_resource, request) => {
    if (request.action === "list-route-conflicts" && !writes.length) {
      return Promise.resolve({
        conflicts: [{
          _id: "route-pair",
          trackIds: ["incoming", "existing"],
          trackNames: [null, null],
          sources: [
            { filename: "later.gpx", importedAt: new Date("2026-10-01") },
            { filename: "earlier.gpx", importedAt: new Date("2026-08-01") },
          ],
          overlapStart: new Date("2026-05-06T12:00Z"),
          overlapEnd: new Date("2026-05-06T13:00Z"),
          medianSeparationM: 5_000,
        }],
        total: 1,
      });
    }
    if (request.action === "resolve-route-conflict") {
      writes.push(request.resolution);
      return Promise.resolve({ success: true });
    }
    return Promise.resolve({ conflicts: [], total: 0 });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LocationConflictReviewDialog
        open
        onOpenChange={vi.fn()}
        gapDistanceM={100}
        gapMinutes={2}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Compare" }));
  fireEvent.click(
    screen.getByRole("button", { name: /Existing route.*earlier\.gpx/ }),
  );
  expect(writes).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Apply decision" }));
  await screen.findByText("Applied 1 decision. See Applied for details.");
  expect(writes).toEqual(["use_second"]);
});
