// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ImportsList } from "./ImportsList";

const file = {
  _id: "bookmarks",
  filename: "Saved places.kmz",
  format: "kmz",
  status: "processed",
  origin: { provider: "organic_maps" },
  pointCount: 0,
  skippedCount: 0,
  createdAt: "2026-11-23T10:10:00Z",
  committedAt: "2026-11-23T10:10:00Z",
  receipt: { bookmarks: 3 },
};
const track = {
  ...file,
  _id: "morning",
  filename: "Morning.gpx",
  format: "gpx",
  receipt: undefined,
  timeRange: { start: "2024-05-20T08:30:00Z", end: "2024-05-20T10:10:00Z" },
};
vi.mock("@/hooks/useLocationQueries", () => ({
  useLocationImports: () => ({ data: [file, track] }),
  useLocationImportSources: () => ({ data: [] }),
  useDeleteLocationImport: () => ({}),
  useUpdateLocationImportSource: () => ({}),
}));
vi.mock(
  "@/components/ActionDialogProvider",
  () => ({ useActionDialog: () => ({}) }),
);
afterEach(cleanup);

it("opens undated places from the compact filename and shows the actual track period", async () => {
  const onShowOnMap = vi.fn();
  render(<ImportsList manageSources onShowOnMap={onShowOnMap} />);
  const files = within(screen.getByRole("list", { name: "Imported files" }))
    .getAllByRole("listitem");
  expect(within(files[0]).getByText("No recorded dates")).toBeTruthy();
  expect(within(files[0]).getByText("3 saved places")).toBeTruthy();
  expect(within(files[1]).getByText(/^Recorded /).textContent).toContain(
    "2024",
  );
  expect(screen.queryByText("File details")).toBeNull();
  within(files[0]).getByRole("button", { name: file.filename }).focus();
  await userEvent.keyboard("{Enter}");
  expect(onShowOnMap).toHaveBeenCalledExactlyOnceWith(file);
  fireEvent.click(
    within(files[1]).getByRole("button", { name: "Show Morning.gpx on map" }),
  );
  expect(onShowOnMap).toHaveBeenLastCalledWith(track);
});

it("opens receipt details on demand and keeps source management in either density", async () => {
  render(<ImportsList manageSources />);
  expect(
    screen.getByRole("button", { name: "Edit source for Saved places.kmz" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Detailed" }));
  const row = within(screen.getAllByRole("listitem")[0]);
  expect(row.getByRole("button", { name: "Delete import Saved places.kmz" }))
    .toBeTruthy();
  expect(row.queryByText("Deduplication")).toBeNull();
  fireEvent.click(row.getByText("File details"));
  expect(await row.findByText("Deduplication")).toBeTruthy();
});
