import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { useSelectedVoiceProfile } from "./useSelectedVoiceProfile";

vi.mock("@/lib/api", () => ({ callResource: vi.fn() }));
const mockCallResource = vi.mocked(api.callResource);

function Probe() {
  const selection = useSelectedVoiceProfile();
  const location = useLocation();
  return (
    <div>
      <span data-testid="selected">
        {selection.selectedProfileId ?? "none"}
      </span>
      <span data-testid="invalid">
        {selection.invalidRequestedProfileId ?? "none"}
      </span>
      <span data-testid="search">{location.search}</span>
      <button
        type="button"
        onClick={() => selection.selectProfile("belka")}
      >
        Belka
      </button>
    </div>
  );
}

function renderProbe(entry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("useSelectedVoiceProfile", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockCallResource.mockResolvedValue([
      { _id: "sky", name: "Sky", is_primary: true },
      { _id: "belka", name: "Belka", is_primary: false },
    ]);
  });

  it("switches profile while preserving the current range and filters", async () => {
    renderProbe(
      "/timeline?profileId=sky&start=10&end=20&speakerIdentity=uncertain",
    );
    await waitFor(() =>
      expect(screen.getByTestId("selected")).toHaveTextContent("sky")
    );
    fireEvent.click(screen.getByRole("button", { name: "Belka" }));
    await waitFor(() => {
      const search = screen.getByTestId("search").textContent ?? "";
      expect(search).toContain("profileId=belka");
      expect(search).toContain("start=10");
      expect(search).toContain("end=20");
      expect(search).toContain("speakerIdentity=uncertain");
    });
    expect(window.localStorage.getItem("voice-identity-selected-profile")).toBe(
      "belka",
    );
  });

  it("does not replace an invalid explicit profile", async () => {
    renderProbe("/settings/voice-identity?profileId=missing&start=10");
    await waitFor(() =>
      expect(screen.getByTestId("invalid")).toHaveTextContent("missing")
    );
    expect(screen.getByTestId("selected")).toHaveTextContent("none");
    expect(screen.getByTestId("search")).toHaveTextContent(
      "profileId=missing",
    );
  });
});
