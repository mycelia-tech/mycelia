import { useSettingsStore } from "@/stores/settingsStore";
import { queryClient } from "./queryClient";

export interface TokenExchangeResponse {
  jwt: string | null;
  error: string | null;
}

let pending: { endpoint: string; promise: Promise<string | null> } | undefined;
let authGeneration = 0;
let sessionMutation: Promise<void> = Promise.resolve();

// A logout must reach the server after an already submitted login has set its
// cookie. Ignoring a late login response alone cannot undo that server session.
function mutateSession<T>(operation: () => Promise<T>): Promise<T> {
  const result = sessionMutation.then(operation, operation);
  sessionMutation = result.then(() => {}, () => {});
  return result;
}

function sessionHeaders() {
  return { "Content-Type": "application/json", "X-Mycelia-Session": "1" };
}

export async function exchangeApiKeyForJWT(
  apiEndpoint: string,
  clientId: string,
  clientSecret: string,
): Promise<TokenExchangeResponse> {
  const generation = ++authGeneration;
  const initialEndpoint = useSettingsStore.getState().apiEndpoint;
  pending = undefined;
  try {
    const response = await mutateSession(() =>
      fetch(`${apiEndpoint.replace(/\/$/, "")}/auth/session`, {
        method: "POST",
        credentials: "include",
        headers: sessionHeaders(),
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
        }),
      })
    );

    const data = await response.json().catch(() => ({}));
    if (
      generation !== authGeneration ||
      useSettingsStore.getState().apiEndpoint !== initialEndpoint
    ) {
      return { jwt: null, error: "Sign-in was superseded by a session change" };
    }
    if (!response.ok || typeof data.access_token !== "string") {
      return {
        jwt: null,
        error: data.error || "Failed to start browser session",
      };
    }
    queryClient.clear();
    if (useSettingsStore.getState().apiEndpoint === apiEndpoint) {
      useSettingsStore.getState().setSessionStatus("authenticated");
      useSettingsStore.getState().setClientSecret("");
    }
    return { jwt: data.access_token, error: null };
  } catch (error) {
    return { jwt: null, error: String(error) };
  }
}

async function readCurrentSession(
  apiEndpoint: string,
  generation: number,
  revision: number,
): Promise<string | null> {
  try {
    const response = await fetch(
      `${apiEndpoint.replace(/\/$/, "")}/auth/session`,
      {
        credentials: "include",
        headers: sessionHeaders(),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (
      generation !== authGeneration ||
      useSettingsStore.getState().apiEndpoint !== apiEndpoint ||
      useSettingsStore.getState().sessionRevision !== revision
    ) return null;
    if (!response.ok || typeof data.access_token !== "string") {
      if (response.status === 401 || response.status === 403) {
        queryClient.clear();
        useSettingsStore.getState().setSessionStatus("anonymous");
      } else if (useSettingsStore.getState().sessionStatus === "unknown") {
        useSettingsStore.getState().setSessionStatus("anonymous");
      }
      return null;
    }
    if (typeof data.client_id === "string") {
      useSettingsStore.getState().setClientId(data.client_id);
    }
    // Refreshing an unchanged session must not invalidate unrelated requests
    // that are already in flight. Login/logout still advance the revision.
    if (useSettingsStore.getState().sessionStatus !== "authenticated") {
      useSettingsStore.getState().setSessionStatus("authenticated");
    }
    return data.access_token;
  } catch {
    if (
      generation === authGeneration &&
      useSettingsStore.getState().apiEndpoint === apiEndpoint &&
      useSettingsStore.getState().sessionRevision === revision
    ) {
      if (useSettingsStore.getState().sessionStatus === "unknown") {
        useSettingsStore.getState().setSessionStatus("anonymous");
      }
    }
    return null;
  }
}

export async function getCurrentJWT(): Promise<string | null> {
  const { apiEndpoint, sessionRevision } = useSettingsStore.getState();
  if (pending?.endpoint === apiEndpoint) return pending.promise;
  const promise = readCurrentSession(
    apiEndpoint,
    authGeneration,
    sessionRevision,
  );
  pending = { endpoint: apiEndpoint, promise };
  try {
    return await promise;
  } finally {
    if (pending?.promise === promise) pending = undefined;
  }
}

export async function endBrowserSession(): Promise<void> {
  const generation = ++authGeneration;
  pending = undefined;
  const { apiEndpoint } = useSettingsStore.getState();
  const response = await mutateSession(() =>
    fetch(`${apiEndpoint.replace(/\/$/, "")}/auth/session`, {
      method: "DELETE",
      credentials: "include",
      headers: sessionHeaders(),
    })
  );
  if (!response.ok) throw new Error("Unable to sign out. Please retry.");
  if (
    generation !== authGeneration ||
    useSettingsStore.getState().apiEndpoint !== apiEndpoint
  ) return;
  queryClient.clear();
  useSettingsStore.getState().setSessionStatus("anonymous");
  useSettingsStore.getState().setClientSecret("");
}
