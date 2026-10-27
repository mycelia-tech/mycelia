import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AudioSourceFilesPage from "./AudioSourceFilesPage";
const { callMock, subscription } = vi.hoisted(() => ({
  callMock: vi.fn(),
  subscription: { callback: (_: unknown[]): unknown => undefined },
}));
vi.mock("@/lib/api", () => ({ api: { callResource: callMock } }));
vi.mock(
  "@/hooks/useMongoChanges",
  () => ({
    useMongoChanges: (_: string, callback: (changes: unknown[]) => void) => {
      subscription.callback = callback;
    },
  }),
);
const id = "64b000000000000000000001";
const source = {
  _id: id,
  path: "/fixtures/voice.m4a",
  ingested: false,
  ingestion: { error: "Old failure" },
};
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["source-files-list"], [source]);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AudioSourceFilesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  callMock.mockReset();
});
describe("Source recovery and minimal updates", () => {
  it("queues the selected source and keeps the error while preventing duplicate clicks", async () => {
    callMock.mockResolvedValue({ jobId: "queued-job" });
    const client = mount();
    const retry = await screen.findByRole("button", {
      name: "Retry voice.m4a",
    });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(retry).toHaveTextContent("Queued"));
    expect(retry).toBeDisabled();
    expect(callMock).toHaveBeenCalledOnce();
    expect(callMock).toHaveBeenCalledWith("jobs", {
      action: "enqueue",
      data: { type: "ingestion", sourceIds: [id], retryErrors: true, limit: 1 },
      trigger: { type: "manual", reason: "source_file_retry" },
    });
    expect(client.getQueryData(["source-files-list"])).toEqual([source]);
  });
  it("refetches canonical rows from a notification that contains only an ID", async () => {
    callMock.mockImplementation((_resource, input) =>
      Promise.resolve(
        input.action === "find"
          ? [{ ...source, ingested: true, ingestion: undefined }]
          : 1,
      )
    );
    const client = mount();
    await act(async () => {
      await subscription.callback([{
        collection: "source_files",
        documentId: id,
        operationType: "update",
        changedFields: ["ingested"],
      }]);
    });
    await waitFor(() =>
      expect(client.getQueryData(["source-files-list"])).toEqual([{
        ...source,
        ingested: true,
        ingestion: undefined,
      }])
    );
    expect(callMock.mock.calls[0][1]).toMatchObject({
      action: "find",
      collection: "source_files",
      options: { limit: 100 },
    });
  });
  it("does not restore old-account rows after unmount and cache clearing", async () => {
    let resolveRows: (rows: unknown[]) => void = () => {};
    callMock.mockImplementation(() =>
      new Promise((resolve) => {
        resolveRows = resolve;
      })
    );
    const client = mount();
    let refresh: unknown;
    act(() => {
      refresh = subscription.callback([{
        collection: "source_files",
        documentId: id,
        operationType: "update",
        changedFields: ["ingested"],
      }]);
    });
    cleanup();
    client.clear();
    await act(async () => {
      resolveRows([{ ...source, ingested: true }]);
      await refresh;
    });
    expect(client.getQueryData(["source-files-list"])).toBeUndefined();
  });
});
