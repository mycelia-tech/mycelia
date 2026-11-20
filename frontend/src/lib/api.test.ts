import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api";
import { useSettingsStore } from "@/stores/settingsStore";
import * as auth from "./auth";

(globalThis as any).fetch = vi.fn();

vi.mock("./auth", () => ({
  getCurrentJWT: vi.fn(),
}));

describe("ApiClient", () => {
  let client: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ApiClient();
    useSettingsStore.setState({
      apiEndpoint: "http://localhost:8000",
      clientId: "test-client",
      clientSecret: "test-secret",
      sessionStatus: "authenticated",
      sessionRevision: 0,
    });
  });

  describe("fetch", () => {
    it("never forwards a newly restored token to the previously selected endpoint", async () => {
      let finish!: (token: string) => void;
      vi.mocked(auth.getCurrentJWT).mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const pending = client.fetch("/test");
      useSettingsStore.getState().setApiEndpoint("https://different.test");
      finish("new-endpoint-token");
      await expect(pending).rejects.toThrow(
        "Session changed before the request",
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it("rejects an old account response after logout", async () => {
      let finish!: (response: Response) => void;
      vi.mocked(fetch).mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      vi.mocked(auth.getCurrentJWT).mockResolvedValue("old-token");
      const pending = client.fetch("/test");
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      useSettingsStore.getState().setSessionStatus("anonymous");
      finish(new Response("private"));
      await expect(pending).rejects.toThrow(
        "Session changed while the request was pending",
      );
    });

    it("makes successful GET request", async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ data: "test" }),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      const response = await client.fetch("/test");

      expect(response.ok).toBe(true);
      const [url, init] = ((globalThis as any).fetch as any).mock.calls[0];
      expect(url).toBe("http://localhost:8000/test");
      // The client sends a Headers instance, not a plain object.
      const headers = init.headers as Headers;
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("Authorization")).toBe("Bearer jwt-token");
    });

    it("throws error on failed request", async () => {
      const mockResponse = new Response(null, {
        status: 404,
        statusText: "Not Found",
      });
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      await expect(client.fetch("/test")).rejects.toThrow(
        "API request failed: 404 Not Found",
      );
    });

    it("includes the server error detail for actionable job failures", async () => {
      const mockResponse = new Response(
        JSON.stringify({
          error:
            "All healthy diarizator provider concurrency slots are reserved",
        }),
        {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "content-type": "application/json" },
        },
      );
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      await expect(client.fetch("/api/resource/jobs")).rejects.toThrow(
        "API request failed: 500 Internal Server Error — All healthy diarizator provider concurrency slots are reserved",
      );
    });

    it("surfaces a safe JSON error returned by the backend", async () => {
      const mockResponse = Response.json(
        {
          success: false,
          error: "Use a path relative to the mounted media folder",
        },
        {
          status: 400,
          statusText: "Bad Request",
          headers: { "X-Mycelia-Request-Id": "request-123" },
        },
      );
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      await expect(client.fetch("/api/resource/media")).rejects.toMatchObject({
        message: expect.stringContaining(
          "Use a path relative to the mounted media folder",
        ),
        requestId: "request-123",
      });
    });

    it("makes request without JWT when not available", async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ data: "test" }),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue(null);

      await client.fetch("/test");

      const callArgs = ((globalThis as any).fetch as any).mock.calls[0];
      expect((callArgs[1].headers as Headers).get("Authorization")).toBeNull();
    });

    it("merges custom headers with default headers", async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ data: "test" }),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      await client.fetch("/test", {
        headers: { "X-Custom-Header": "value" },
      });

      const [url, init] = ((globalThis as any).fetch as any).mock.calls[0];
      expect(url).toBe("http://localhost:8000/test");
      const headers = init.headers as Headers;
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("Authorization")).toBe("Bearer jwt-token");
      expect(headers.get("X-Custom-Header")).toBe("value");
    });
  });

  describe("JWT caching", () => {
    it("caches JWT for subsequent requests", async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ data: "test" }),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      await client.fetch("/test1");
      await client.fetch("/test2");

      expect(auth.getCurrentJWT).toHaveBeenCalledTimes(1);
    });

    it("refreshes JWT after cache expiry", async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ data: "test" }),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any)
        .mockResolvedValueOnce("jwt-token-1")
        .mockResolvedValueOnce("jwt-token-2");

      await client.fetch("/test1");

      vi.useFakeTimers();
      vi.advanceTimersByTime(7 * 60 * 60 * 1000);

      await client.fetch("/test2");

      expect(auth.getCurrentJWT).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });
  });

  describe("get", () => {
    it("performs GET request and returns JSON", async () => {
      const mockData = { id: 1, name: "test" };
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue(mockData),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      const result = await client.get("/items/1");

      expect(result).toEqual(mockData);
    });
  });

  describe("post", () => {
    it("performs POST request with data", async () => {
      const postData = { name: "new item" };
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 1, ...postData }),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      const result = await client.post("/items", postData);

      expect(result).toEqual({ id: 1, ...postData });
      expect((globalThis as any).fetch).toHaveBeenCalledWith(
        "http://localhost:8000/items",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(postData),
        }),
      );
    });
  });

  describe("postForm", () => {
    it("lets the browser set the multipart boundary", async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ success: true }),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");
      const form = new FormData();
      form.append("files", new Blob(["photo"]), "photo.jpg");

      await client.postForm("/api/media/imports/analyze", form);

      const [url, init] = ((globalThis as any).fetch as any).mock.calls[0];
      expect(url).toBe(
        "http://localhost:8000/api/media/imports/analyze",
      );
      expect(init.body).toBe(form);
      expect((init.headers as Headers).get("Content-Type")).toBeNull();
      expect((init.headers as Headers).get("Authorization")).toBe(
        "Bearer jwt-token",
      );
    });
  });

  describe("put", () => {
    it("performs PUT request with data", async () => {
      const updateData = { name: "updated item" };
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 1, ...updateData }),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      const result = await client.put("/items/1", updateData);

      expect(result).toEqual({ id: 1, ...updateData });
      expect((globalThis as any).fetch).toHaveBeenCalledWith(
        "http://localhost:8000/items/1",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify(updateData),
        }),
      );
    });
  });

  describe("delete", () => {
    it("performs DELETE request", async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ success: true }),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      const result = await client.delete("/items/1");

      expect(result).toEqual({ success: true });
      expect((globalThis as any).fetch).toHaveBeenCalledWith(
        "http://localhost:8000/items/1",
        expect.objectContaining({
          method: "DELETE",
        }),
      );
    });
  });

  describe("testConnection", () => {
    it("returns true on successful connection", async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      const result = await client.testConnection();

      expect(result).toBe(true);
    });

    it("returns false on failed connection", async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      const result = await client.testConnection();

      expect(result).toBe(false);
    });

    it("returns false on network error", async () => {
      ((globalThis as any).fetch as any).mockRejectedValue(
        new Error("Network error"),
      );
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      const result = await client.testConnection();

      expect(result).toBe(false);
    });
  });

  describe("callResource", () => {
    it("calls resource with EJSON serialization", async () => {
      const requestBody = { action: "find", collection: "items" };
      const responseData = [{ id: 1, name: "item1" }];
      const mockResponse = {
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(responseData)),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      const result = await client.callResource(
        "mongo",
        requestBody,
      );

      expect(result).toEqual(responseData);
      expect((globalThis as any).fetch).toHaveBeenCalledWith(
        "http://localhost:8000/api/resource/mongo",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    it("handles EJSON dates correctly", async () => {
      const testDate = new Date("2024-01-15T00:00:00.000Z");
      const requestBody = { date: testDate };
      const mockResponse = {
        ok: true,
        text: vi.fn().mockResolvedValue(
          '{"date":{"$date":"2024-01-15T00:00:00.000Z"}}',
        ),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      const result = await client.callResource(
        "test",
        requestBody,
      );

      expect(result.date).toBeInstanceOf(Date);
      expect(result.date.toISOString()).toBe("2024-01-15T00:00:00.000Z");
    });

    it("omits undefined object fields instead of sending them as null", async () => {
      const mockResponse = {
        ok: true,
        text: vi.fn().mockResolvedValue('{"items":[]}'),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      await client.callResource("objects", {
        action: "listCards",
        section: "person",
        filters: {
          search: undefined,
          tagIds: undefined,
          tagMode: "and",
          orphanedOnly: undefined,
          explicitNull: null,
        },
        cursor: undefined,
        limit: 9,
      });

      const [, init] = ((globalThis as any).fetch as any).mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({
        action: "listCards",
        section: "person",
        filters: { tagMode: "and", explicitNull: null },
        limit: 9,
      });
    });

    it("forwards an AbortSignal to the resource request", async () => {
      const controller = new AbortController();
      const mockResponse = {
        ok: true,
        text: vi.fn().mockResolvedValue('{"items":[]}'),
      };
      ((globalThis as any).fetch as any).mockResolvedValue(mockResponse);
      (auth.getCurrentJWT as any).mockResolvedValue("jwt-token");

      await client.callResource(
        "objects",
        { action: "listCards", section: "person" },
        { signal: controller.signal },
      );

      expect((globalThis as any).fetch).toHaveBeenCalledWith(
        "http://localhost:8000/api/resource/objects",
        expect.objectContaining({ signal: controller.signal }),
      );
    });
  });
});
