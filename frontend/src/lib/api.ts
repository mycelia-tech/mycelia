import { EJSON } from "bson";
import { useSettingsStore } from "@/stores/settingsStore";
import { getCurrentJWT } from "./auth";

export interface CallResourceOptions {
  signal?: AbortSignal;
}

export class ApiRequestError extends Error {
  constructor(message: string, readonly requestId?: string) {
    super(message);
  }
}

/**
 * EJSON serializes object properties whose value is `undefined` as `null`,
 * unlike JSON.stringify, which omits them. Resource schemas use optional
 * fields to distinguish an omitted value from an explicit null, so preserve
 * normal JSON request semantics while leaving BSON values (Date/ObjectId,
 * etc.) intact for EJSON.
 */
function omitUndefinedObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitUndefinedObjectProperties);
  }
  if (value === null || typeof value !== "object") return value;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, nested]) =>
      nested === undefined ? [] : [[key, omitUndefinedObjectProperties(nested)]]
    ),
  );
}

async function readApiError(response: Response): Promise<string> {
  const fallback =
    `API request failed: ${response.status} ${response.statusText}`;
  try {
    const payload = await response.json();
    const candidate = payload?.error ?? payload?.message;
    if (typeof candidate === "string" && candidate.trim()) {
      return `${fallback} — ${candidate.trim()}`;
    }
    if (Array.isArray(candidate)) {
      const firstMessage = candidate.find((entry) =>
        typeof entry?.message === "string"
      )?.message;
      if (firstMessage) return `${fallback} — ${firstMessage}`;
    }
  } catch {
    // Preserve the status fallback for empty or non-JSON error responses.
  }
  return fallback;
}

export class ApiClient {
  private jwtCache: {
    token: string;
    expiry: number;
    endpoint: string;
    clientId: string;
    revision: number;
  } | null = null;

  private getConfig() {
    const { apiEndpoint, clientId, clientSecret } = useSettingsStore.getState();
    return { apiEndpoint, clientId, clientSecret };
  }

  async getJWT(): Promise<string | null> {
    const current = useSettingsStore.getState();
    if (current.sessionStatus === "anonymous") this.jwtCache = null;
    if (
      this.jwtCache && this.jwtCache.expiry > Date.now() &&
      this.jwtCache.endpoint === current.apiEndpoint &&
      this.jwtCache.clientId === current.clientId &&
      this.jwtCache.revision === current.sessionRevision
    ) {
      return this.jwtCache.token;
    }

    const jwt = await getCurrentJWT();

    if (jwt) {
      let expiry = Date.now() + 60_000;
      try {
        const payload = JSON.parse(
          atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
        );
        if (typeof payload.exp === "number") {
          expiry = payload.exp * 1000 - 30_000;
        }
      } catch { /* Opaque tokens cannot be cached beyond one minute. */ }
      this.jwtCache = {
        token: jwt,
        expiry,
        endpoint: useSettingsStore.getState().apiEndpoint,
        clientId: useSettingsStore.getState().clientId,
        revision: useSettingsStore.getState().sessionRevision,
      };
    }

    return jwt;
  }

  async getAuthHeaders(): Promise<HeadersInit> {
    const jwt = await this.getJWT();
    if (!jwt) {
      return {};
    }
    return {
      "Authorization": `Bearer ${jwt}`,
    };
  }

  get baseURL(): string {
    const { apiEndpoint } = this.getConfig();
    return apiEndpoint.replace(/\/$/, "");
  }

  /**
   * Authenticated fetch that returns the raw Response without throwing on
   * HTTP errors — callers that need the server's error payload use this.
   */
  async fetchRaw(path: string, options: RequestInit = {}): Promise<Response> {
    const { apiEndpoint } = this.getConfig();
    const url = `${apiEndpoint}${path}`;

    const headers = new Headers();

    for (const [key, value] of Object.entries(await this.getAuthHeaders())) {
      headers.set(key, value);
    }
    // Session restoration can await network I/O. Never send credentials from
    // the newly selected endpoint to the URL captured before that await.
    const session = useSettingsStore.getState();
    if (session.apiEndpoint !== apiEndpoint) {
      throw new Error("Session changed before the request");
    }
    for (const [key, value] of Object.entries(options.headers || {})) {
      headers.set(key, value);
    }

    if (
      !headers.has("Content-Type") && !(options.body instanceof FormData)
    ) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });
    const current = useSettingsStore.getState();
    if (
      current.apiEndpoint !== session.apiEndpoint ||
      current.clientId !== session.clientId ||
      current.sessionRevision !== session.sessionRevision
    ) {
      throw new Error("Session changed while the request was pending");
    }
    return response;
  }

  async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    const response = await this.fetchRaw(path, options);

    if (!response.ok) {
      throw new ApiRequestError(
        await readApiError(response),
        response.headers.get("X-Mycelia-Request-Id") ?? undefined,
      );
    }

    return response;
  }

  async get<T>(path: string): Promise<T> {
    const response = await this.fetch(path);
    return response.json();
  }

  async post<T>(path: string, data: unknown): Promise<T> {
    const response = await this.fetch(path, {
      method: "POST",
      body: JSON.stringify(data),
    });
    return response.json();
  }

  async postForm<T>(path: string, data: FormData): Promise<T> {
    const response = await this.fetchRaw(path, {
      method: "POST",
      body: data,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof payload?.error === "string"
        ? payload.error
        : `API request failed: ${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return payload as T;
  }

  async getBlob(path: string): Promise<Blob> {
    const response = await this.fetch(path, {
      method: "GET",
    });
    return response.blob();
  }

  async put<T>(path: string, data: unknown): Promise<T> {
    const response = await this.fetch(path, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    return response.json();
  }

  async delete<T>(path: string): Promise<T> {
    const response = await this.fetch(path, {
      method: "DELETE",
    });
    return response.json();
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.fetch("resource", {});
      return true;
    } catch {
      return false;
    }
  }

  async callResource(
    resource: string,
    body: any,
    options: CallResourceOptions = {},
  ): Promise<any> {
    const response = await this.fetch(`/api/resource/${resource}`, {
      method: "POST",
      body: EJSON.stringify(omitUndefinedObjectProperties(body)),
      signal: options.signal,
    });
    return EJSON.parse(await response.text());
  }
}

export const apiClient = new ApiClient();

// Backwards compatibility alias
export const api = apiClient;

export const callResource = (
  resource: string,
  body: any,
  options?: CallResourceOptions,
) => {
  return apiClient.callResource(resource, body, options);
};
