import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { callResource } from "@/lib/api";
import {
  activeSourceFilter,
  ALL_LOCATION_SOURCES,
  LocationSourceFilter,
} from "./LocationSourceFilter";

vi.mock("@/lib/api", () => ({ callResource: vi.fn() }));

it("can focus an individual file without listing sibling pages or changing the visibility checkboxes", async () => {
  const file = { _id: "0123456789abcdef01234567", filename: "Walk.gpx" };
  vi.mocked(callResource).mockImplementation(async (_resource, input) => {
    if (input.action === "list-import-sources") return [{ provider: "reitti", count: 120 }];
    if (input.action === "list-source-files") return { files: [file], hasMore: true };
    throw new Error("Unexpected resource action");
  });
  const show = vi.fn();
  const change = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = { label: "Marker sources", onChange: change, onShowOnMap: show };
  const { rerender } = render(
    <QueryClientProvider client={client}>
      <LocationSourceFilter {...props} filter={ALL_LOCATION_SOURCES} />
    </QueryClientProvider>,
  );
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Marker sources" }));

  expect(callResource).not.toHaveBeenCalled();
  open();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Show Reitti" }));
  expect(change).toHaveBeenCalledWith({ ...ALL_LOCATION_SOURCES, excludedProviders: ["reitti"] });
  expect(show).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show Reitti on map" }));
  expect(show).toHaveBeenLastCalledWith({ provider: "reitti", label: "Reitti" });
  expect(vi.mocked(callResource).mock.calls.map(([, input]) => input.action)).toEqual(["list-import-sources"]);

  open();
  fireEvent.click(screen.getByRole("button", { name: "Browse Reitti files" }));
  fireEvent.click(await screen.findByRole("button", { name: "Show Walk.gpx on map" }));
  const focus = { provider: "reitti", importId: file._id, label: file.filename };
  expect(show).toHaveBeenLastCalledWith(focus);
  expect(vi.mocked(callResource).mock.calls.map(([, input]) => input.action)).toEqual([
    "list-import-sources", "list-source-files",
  ]);

  const filtered = { ...ALL_LOCATION_SOURCES, onlyImportId: file._id };
  expect(activeSourceFilter(filtered)).toEqual(filtered);
  rerender(
    <QueryClientProvider client={client}>
      <LocationSourceFilter {...props} filter={filtered} focus={focus} />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("button", { name: "Marker sources" })).toHaveTextContent(file.filename);
  fireEvent.click(screen.getByRole("button", { name: "Clear marker sources focus" }));
  expect(change).toHaveBeenLastCalledWith(ALL_LOCATION_SOURCES);
});
