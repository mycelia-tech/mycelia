import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/settingsStore";
import { endBrowserSession, exchangeApiKeyForJWT, getCurrentJWT } from "./auth";
import { queryClient } from "./queryClient";
import { ApiClient } from "./api";

describe("browser session authentication", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    useSettingsStore.setState({
      apiEndpoint: "https://mycelia.test",
      clientId: "client",
      clientSecret: "",
      sessionStatus: "unknown",
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it("exchanges entered credentials for an HttpOnly-backed session without persisting the secret", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ access_token: "short-token" })),
    );
    useSettingsStore.getState().setClientSecret("permanent-secret");
    const result = await exchangeApiKeyForJWT(
      "https://mycelia.test",
      "client",
      "permanent-secret",
    );
    expect(result).toEqual({ jwt: "short-token", error: null });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://mycelia.test/auth/session");
    expect(init?.credentials).toBe("include");
    expect(new Headers(init?.headers).get("X-Mycelia-Session")).toBe("1");
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: "client",
      client_secret: "permanent-secret",
    });
    expect(useSettingsStore.getState().clientSecret).toBe("");
    expect(useSettingsStore.getState().sessionStatus).toBe("authenticated");
    expect(window.localStorage.getItem("mycelia-settings")).not.toContain(
      "permanent-secret",
    );
  });

  it("restores a session without needing a saved API secret and coalesces concurrent requests", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "short-token", client_id: "restored" }),
      ),
    );
    const [first, second] = await Promise.all([
      getCurrentJWT(),
      getCurrentJWT(),
    ]);
    expect(first).toBe("short-token");
    expect(second).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().clientId).toBe("restored");
    expect(useSettingsStore.getState().sessionStatus).toBe("authenticated");
  });

  it("does not reuse expired or revoked sessions", async () => {
    queryClient.setQueryData(["private-result"], "private");
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "session_expired" }), {
        status: 401,
      }),
    );
    expect(await getCurrentJWT()).toBeNull();
    expect(useSettingsStore.getState().sessionStatus).toBe("anonymous");
    expect(queryClient.getQueryData(["private-result"])).toBeUndefined();
  });

  it("preserves authenticated state and cache during a temporary server failure", async () => {
    useSettingsStore.getState().setSessionStatus("authenticated");
    queryClient.setQueryData(["private-result"], "private");
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
    expect(await getCurrentJWT()).toBeNull();
    expect(useSettingsStore.getState().sessionStatus).toBe("authenticated");
    expect(queryClient.getQueryData(["private-result"])).toBe("private");
  });

  it("keeps in-flight API results valid when the same session renews", async () => {
    const client = new ApiClient();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: "first-token", client_id: "client",
    })));
    await client.getJWT();
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise((resolve) => {
      finish = resolve;
    }));
    const request = client.get<{ result: string }>("/api/example");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: "renewed-token", client_id: "client",
    })));
    expect(await getCurrentJWT()).toBe("renewed-token");
    finish(new Response(JSON.stringify({ result: "retained" })));
    await expect(request).resolves.toEqual({ result: "retained" });
  });

  it("does not apply a late response from the previous endpoint", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const result = getCurrentJWT();
    useSettingsStore.getState().setApiEndpoint("https://different.test");
    finish(
      new Response(
        JSON.stringify({ access_token: "old-token", client_id: "old" }),
      ),
    );
    expect(await result).toBeNull();
    expect(useSettingsStore.getState().clientId).toBe("client");
  });

  it("shows login errors and never persists failed credentials", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 401,
      }),
    );
    expect(
      await exchangeApiKeyForJWT("https://mycelia.test", "client", "wrong"),
    ).toEqual({ jwt: null, error: "invalid_client" });
    expect(useSettingsStore.getState().clientSecret).toBe("");
  });

  it("ends the server session before changing local login state", async () => {
    useSettingsStore.getState().setSessionStatus("authenticated");
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(endBrowserSession()).rejects.toThrow("Unable to sign out");
    expect(useSettingsStore.getState().sessionStatus).toBe("authenticated");
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}"));
    await endBrowserSession();
    expect(useSettingsStore.getState().sessionStatus).toBe("anonymous");
    expect(vi.mocked(fetch).mock.calls[1][1]?.method).toBe("DELETE");
  });

  it("orders logout after an in-flight login and ignores the superseded login response", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}"));
    const login = exchangeApiKeyForJWT(
      "https://mycelia.test",
      "client",
      "synthetic-secret",
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const logout = endBrowserSession();
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(new Response(JSON.stringify({ access_token: "superseded" })));
    expect((await login).jwt).toBeNull();
    await logout;
    expect(vi.mocked(fetch).mock.calls.map((call) => call[1]?.method)).toEqual([
      "POST",
      "DELETE",
    ]);
    expect(useSettingsStore.getState().sessionStatus).toBe("anonymous");
  });

  it("removes a legacy secret when persisted settings are migrated", async () => {
    window.localStorage.setItem(
      "mycelia-settings",
      JSON.stringify({
        state: {
          apiEndpoint: "https://mycelia.test",
          clientId: "old-client",
          clientSecret: "old-permanent-secret",
          theme: "dark",
        },
        version: 0,
      }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().clientSecret).toBe("");
    expect(useSettingsStore.getState().theme).toBe("dark");
    expect(window.localStorage.getItem("mycelia-settings")).not.toContain(
      "old-permanent-secret",
    );
  });
});
