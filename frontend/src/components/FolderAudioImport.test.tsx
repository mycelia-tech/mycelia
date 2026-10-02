import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { FolderAudioImport } from "./FolderAudioImport";
import { api } from "@/lib/api";
vi.mock("@/lib/api", () => ({ api: { callResource: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => vi.resetAllMocks());
it("queues the persisted folder and requires saving edits before import", async () => {
  const call = vi.mocked(api.callResource);
  call.mockResolvedValue({ path: "/selected", automatic: false });
  render(
    <QueryClientProvider
      client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}
    >
      <MemoryRouter>
        <FolderAudioImport
          host={{ reachable: true, status: "healthy", folderSource: null }}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const path = await screen.findByDisplayValue("/selected");
  const run = screen.getByRole("button", { name: "Scan and import" });
  fireEvent.click(run);
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("jobs", {
      action: "enqueue",
      data: { type: "ingestion", sourceFolder: "/selected", limit: 20 },
    })
  );
  fireEvent.change(path, { target: { value: "/different" } });
  expect(run).toBeDisabled();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Save folder" }));
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("mongo", {
      action: "updateOne",
      collection: "host_ingestion_config",
      query: { _id: "audio-folder" },
      update: { $set: { path: "/different", automatic: true } },
      options: { upsert: true },
    })
  );
});
