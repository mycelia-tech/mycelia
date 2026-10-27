import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import * as userEventLib from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const { callResourceMock } = vi.hoisted(() => ({
  callResourceMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ callResource: callResourceMock }));
vi.mock("@/modules/histogram/useHistogramItems", () => ({
  useHistogramItems: () => ({ items: [], resolution: "day" }),
}));

import SearchPage from "./SearchPage";

const userEvent = (userEventLib as any).default || userEventLib;

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}
    >
      <MemoryRouter>
        <SearchPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SearchPage", () => {
  beforeEach(() => {
    callResourceMock.mockReset();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });

  it("uses hybrid retrieval by default and renders canonical evidence", async () => {
    callResourceMock.mockResolvedValue({
      projectionId: "rag-v3",
      mode: "hybrid",
      tookMs: 42,
      degraded: false,
      warnings: [],
      freshness: {
        lifecycleState: "ready",
        checkpointState: "watching",
        checkpointAt: "2026-08-26T10:01:00.000Z",
        lagSeconds: 2,
        paused: false,
      },
      revalidation: {
        state: "verified",
        checkedSources: 1,
        droppedCandidates: 0,
        staleCandidates: 0,
        filterRefinedCandidates: 0,
      },
      selection: {
        candidateCount: 1,
        verifiedCandidates: 1,
        returnedCount: 1,
        distinctSources: 1,
        distinctGroups: 1,
        maxPerSource: 2,
      },
      results: [{
        evidenceId: "rag-v3:object:o1:0:sha256-one",
        pointId: "object:o1:0",
        score: 0.9123,
        text: "The migration stays read-only during the first rollout.",
        source: {
          kind: "object",
          collection: "objects",
          id: "o1",
          uri: "/objects/o1",
          title: "Database migration",
          start: "2026-08-20T10:00:00.000Z",
          platform: null,
          groupId: "objects:o1",
          sourceHash: "source-hash-one",
        },
        chunk: { index: 0, contentHash: "sha256:one" },
      }],
    });
    const user = userEvent.setup();
    renderPage();

    await user.type(
      screen.getByLabelText("Question or phrase"),
      "migration decision",
    );
    await user.type(screen.getByLabelText("Exact platforms"), "mycelia");
    await user.type(
      screen.getByLabelText("Exact message sender IDs"),
      "person-me",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Database migration")).toBeTruthy();
    expect(screen.getByText(/read-only during the first rollout/)).toBeTruthy();
    expect(
      screen.getByText(/ready · checkpoint watching · 2s lag/),
    ).toBeTruthy();
    expect(screen.getByText("Mongo verified")).toBeTruthy();
    expect(screen.getByTestId("rag-search-summary").textContent).toContain(
      "1 sources · 1 contexts",
    );
    expect(screen.getByText(/evidence: rag-v3:object:o1/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Open source/ }).getAttribute("href"),
    ).toBe("/objects/o1");

    const searchCall = callResourceMock.mock.calls.find(([, body]) =>
      body.action === "search"
    );
    expect(searchCall?.[0]).toBe("rag");
    expect(searchCall?.[1]).toEqual({
      action: "search",
      query: "migration decision",
      mode: "hybrid",
      platforms: ["mycelia"],
      senderIds: ["person-me"],
      limit: 10,
      maxPerSource: 2,
    });
    expect(searchCall?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("shows the actual fallback mode and warning for degraded retrieval", async () => {
    callResourceMock.mockResolvedValue({
      projectionId: "rag-v3",
      mode: "lexical",
      tookMs: 12,
      degraded: true,
      warnings: ["Dense vectors are unavailable; lexical fallback was used."],
      freshness: {
        lifecycleState: "degraded",
        checkpointState: "error",
        checkpointAt: null,
        lagSeconds: null,
        paused: false,
      },
      revalidation: {
        state: "degraded",
        checkedSources: 0,
        droppedCandidates: 1,
        staleCandidates: 1,
        filterRefinedCandidates: 0,
      },
      selection: {
        candidateCount: 1,
        verifiedCandidates: 0,
        returnedCount: 0,
        distinctSources: 0,
        distinctGroups: 0,
        maxPerSource: 2,
      },
      results: [],
    });
    const user = userEvent.setup();
    renderPage();

    await user.type(
      screen.getByLabelText("Question or phrase"),
      "exact phrase",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Degraded retrieval")).toBeTruthy();
    expect(screen.getByText(/lexical fallback was used/)).toBeTruthy();
    expect(screen.getByTestId("rag-search-summary").textContent).toContain(
      "lexical retrieval · 12 ms",
    );
    expect(screen.getByText("No indexed evidence matched")).toBeTruthy();
  });

  it("does not present a failed search as an authoritative empty result", async () => {
    callResourceMock.mockResolvedValue({
      success: false,
      degraded: true,
      error: {
        code: "rag_unavailable",
        message: "Qdrant is unavailable",
        retryable: true,
      },
      warnings: [
        "RAG search is unavailable. Do not interpret this as an empty result set.",
      ],
      results: [],
    });
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText("Question or phrase"), "some fact");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Qdrant is unavailable",
    );
    await waitFor(() => {
      expect(screen.queryByText("No indexed evidence matched")).toBeNull();
      expect(screen.queryByText(/0 results/)).toBeNull();
    });
  });
});
