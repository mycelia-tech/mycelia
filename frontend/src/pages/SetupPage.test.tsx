import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SetupPage from "./SetupPage";

const tokenCommand =
  "docker exec -it -w /app mycelia-media-89da-backend-1 deno run -A server.ts token-create --name Browser-2026-08-21";

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    apiEndpoint: "http://127.0.0.1:3211",
    clientId: "",
    clientSecret: "",
    sessionStatus: "anonymous",
    setApiEndpoint: vi.fn(),
    setClientId: vi.fn(),
    setClientSecret: vi.fn(),
  }),
}));

vi.mock("@/lib/setupCommands", () => ({
  getDockerSetupEndpoint: () => "http://127.0.0.1:3211",
  getDockerTokenCommand: () => tokenCommand,
  isMediaDevSetupLocation: () => true,
}));

vi.mock("@/lib/auth", () => ({
  exchangeApiKeyForJWT: vi.fn(),
  getCurrentJWT: vi.fn().mockResolvedValue(null),
}));

describe("SetupPage isolated media stack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );
  });

  it("shows the working token command for port 3211", () => {
    render(
      <MemoryRouter initialEntries={["/setup"]}>
        <SetupPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText("See how to generate them"));

    expect(screen.getByText(tokenCommand)).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:3211")).toBeTruthy();
    expect(screen.queryByText("Local development (deno task dev)")).toBeNull();
  });

  it("shows HTTP 500 as a connection error rather than a successful server check", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: "unavailable" }), { status: 500 }));
    render(<MemoryRouter><SetupPage /></MemoryRouter>);
    fireEvent.click(screen.getByTitle("Test server connection"));
    expect(await screen.findByText("Server returned HTTP 500.")).toBeTruthy();
    expect(screen.queryByText(/Mycelia server recognized/)).toBeNull();
  });

  it("rejects an unrelated server and ignores a stale check after the endpoint changes", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<MemoryRouter><SetupPage /></MemoryRouter>);
    fireEvent.click(screen.getByTitle("Test server connection"));
    fireEvent.change(screen.getByLabelText("Server Endpoint"), { target: { value: "https://new.test" } });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ unrelated: true })));
    finish(new Response(JSON.stringify({ service: "mycelia" })));
    fireEvent.click(screen.getByTitle("Test server connection"));
    await waitFor(() => expect(screen.getByText("The address did not return a Mycelia setup response.")).toBeTruthy());
    expect(screen.queryByText(/Mycelia server recognized/)).toBeNull();
  });
});
