import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkersPage from "./WorkersPage";
const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ callResource: callMock }));
const dashboard = {
  catalog: {
    workers: [{
      type: "ingestion",
      label: "Ingestion",
      description: "Imports",
      availability: "ready",
      capabilities: { pause: true },
    }],
    schemas: {},
  },
  runtime: { workers: { ingestion: { paused: false } } },
};
beforeEach(() => {
  callMock.mockReset();
});
describe("Worker action feedback", () => {
  it("keeps the worker state after failure and offers a retry", async () => {
    callMock.mockResolvedValueOnce(dashboard).mockRejectedValueOnce(
      new Error("Backend unavailable"),
    ).mockResolvedValueOnce({});
    render(
      <MemoryRouter>
        <WorkersPage />
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Pause Ingestion" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Backend unavailable",
    );
    expect(screen.getByRole("button", { name: "Pause Ingestion" }))
      .toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Resume Ingestion" }))
      .toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("ingestion paused");
    expect(
      callMock.mock.calls.filter(([, input]) =>
        input.action === "pause_worker"
      ),
    ).toHaveLength(2);
  });
  it("blocks duplicate pause requests while pending", async () => {
    callMock.mockResolvedValueOnce(dashboard).mockImplementationOnce(() =>
      new Promise(() => {})
    );
    render(
      <MemoryRouter>
        <WorkersPage />
      </MemoryRouter>,
    );
    const button = await screen.findByRole("button", {
      name: "Pause Ingestion",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(callMock).toHaveBeenCalledTimes(2);
  });
});
