import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSearchForm,
  searchFormParams,
  useMemorySearch,
} from "./useMemorySearch";
const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }));
vi.mock(
  "@/lib/rag",
  () => ({
    ragApi: { search: searchMock },
    ragErrorMessage: (error: Error) => error.message,
  }),
);
vi.mock(
  "@/stores/settingsStore",
  () => ({
    useSettingsStore: (select: (state: { apiEndpoint: string }) => unknown) =>
      select({ apiEndpoint: "http://test.invalid" }),
  }),
);
function Search() {
  const result = useMemorySearch();
  const location = useLocation();
  return (
    <>
      <input
        aria-label="Query"
        value={result.form.query}
        onChange={(event) => result.setField("query", event.target.value)}
      />
      <button type="button" onClick={result.submit}>Search</button>
      <output data-testid="url">{location.search}</output>
      <p>{result.response?.results[0]?.text}</p>
      <Link to="/source">Source</Link>
    </>
  );
}
function Source() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>Back</button>;
}
function mount(entry = "/search") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/search" element={<Search />} />
          <Route path="/source" element={<Source />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  searchMock.mockReset().mockResolvedValue({
    results: [{ text: "Remembered result" }],
  });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
describe("Search URL and navigation state", () => {
  it("normalizes invalid filters and round-trips valid time/source filters", () => {
    expect(
      readSearchForm(
        new URLSearchParams(
          "mode=unknown&limit=999&start=invalid&kinds=object,nope",
        ),
      ).mode,
    ).toBe("hybrid");
    const form = readSearchForm(
      new URLSearchParams(
        "q=remember&mode=semantic&start=2026-01-01T00:00:00Z&end=2026-01-02T00:00:00Z&collection=transcriptions&source=abc&platforms=telegram&senders=me&perSource=3",
      ),
    );
    expect(readSearchForm(searchFormParams(form))).toEqual(form);
  });
  it("restores submitted query, cached results and scroll on Back without another request", async () => {
    mount();
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "memories" },
    });
    fireEvent.click(screen.getByText("Search"));
    expect(await screen.findByText("Remembered result")).toBeInTheDocument();
    expect(screen.getByTestId("url")).toHaveTextContent("q=memories");
    await waitFor(() => expect(window.scrollTo).toHaveBeenCalled());
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 420,
    });
    fireEvent.scroll(window);
    fireEvent.click(screen.getByText("Source"));
    fireEvent.click(await screen.findByText("Back"));
    expect(await screen.findByDisplayValue("memories")).toBeInTheDocument();
    expect(screen.getByText("Remembered result")).toBeInTheDocument();
    await waitFor(() =>
      expect(window.scrollTo).toHaveBeenLastCalledWith({
        top: 420,
        behavior: "instant",
      })
    );
    expect(searchMock).toHaveBeenCalledTimes(1);
  });
  it("runs a restored URL query with its exact filters on a fresh load", async () => {
    mount(
      "/search?q=decision&mode=lexical&kinds=message&platforms=telegram&limit=20",
    );
    expect(await screen.findByText("Remembered result")).toBeInTheDocument();
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "decision",
        mode: "lexical",
        kinds: ["message"],
        platforms: ["telegram"],
        limit: 20,
      }),
      expect.any(AbortSignal),
    );
  });
});
