import { expect, type Page, test as base } from "@playwright/test";

export const BASE_URL = "http://127.0.0.1:43117";
export const SOURCE_ID = "64b000000000000000000001";
export type MockBackend = {
  requests: { resource: string; body: Record<string, unknown> }[];
  chatUnavailable: boolean;
};

const source = {
  _id: { $oid: SOURCE_ID },
  path: "/fictional-smoke/harbor-picnic.m4a",
  ingested: true,
  start: { $date: "2026-01-05T10:00:00Z" },
  duration: 120,
  size: 1024,
  platform: { importer: "smoke-fixture", system: "Fictional test host" },
};
function searchResponse() {
  return {
    projectionId: "fictional-smoke-index",
    mode: "hybrid",
    degraded: false,
    tookMs: 12,
    freshness: {
      lifecycleState: "ready",
      checkpointState: "watching",
      checkpointAt: "2026-01-05T10:00:00Z",
      lagSeconds: 0,
      paused: false,
    },
    revalidation: {
      state: "verified",
      checkedSources: 10,
      droppedCandidates: 0,
      staleCandidates: 0,
      filterRefinedCandidates: 0,
    },
    selection: {
      candidateCount: 10,
      verifiedCandidates: 10,
      returnedCount: 10,
      distinctSources: 10,
      distinctGroups: 10,
      maxPerSource: 2,
    },
    results: Array.from({ length: 10 }, (_, index) => ({
      pointId: `fictional-note-${index}`,
      score: 0.9,
      text: `Fictional memory ${
        index + 1
      }: We planned a picnic by the harbor and agreed to bring a blue blanket. This record contains only invented browser-test data.`,
      evidenceId: `fictional-evidence-${index}`,
      source: {
        kind: "transcription",
        collection: "transcriptions",
        id: `fictional-transcript-${index}`,
        uri: `/audio/source_files/${SOURCE_ID}`,
        title: `Harbor picnic recording ${index + 1}`,
        start: "2026-01-05T10:00:00Z",
        end: "2026-01-05T10:02:00Z",
        platform: "mycelia",
        groupId: `fictional-group-${index}`,
        sourceHash: "fictional-revision",
      },
    })),
  };
}

async function mockNetwork(page: Page, state: MockBackend, blocked: string[]) {
  // No real credentials or data are read. All backend routes are intercepted.
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (url.origin !== BASE_URL) {
      blocked.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    if (url.pathname === "/auth/session" && request.method() === "GET") {
      await json({
        access_token: "fictional-browser-smoke-token",
        client_id: "fictional-smoke-user",
      });
      return;
    }
    if (url.pathname.startsWith("/api/resource/")) {
      const resource = url.pathname.split("/").at(-1)!;
      const body = request.postDataJSON() as Record<string, unknown>;
      state.requests.push({ resource, body });
      if (resource === "jobs" && body.action === "list") {
        await json([]);
        return;
      }
      if (resource === "jobs" && body.action === "get_jobs_dashboard") {
        await json({
          catalog: { workers: [], schemas: {} },
          runtime: { workers: {} },
        });
        return;
      }
      if (resource === "rag" && body.action === "search") {
        await json(searchResponse());
        return;
      }
      if (
        resource === "mongo" && body.collection === "chats" &&
        body.action === "find"
      ) {
        if (state.chatUnavailable) {
          await json({ error: "Fictional server outage" }, 500);
        } else await json([]);
        return;
      }
      if (
        resource === "mongo" && body.collection === "source_files" &&
        body.action === "findOne"
      ) {
        await json(source);
        return;
      }
      if (
        resource === "mongo" && body.collection === "audio_chunks" &&
        body.action === "count"
      ) {
        await json(12);
        return;
      }
      if (
        resource === "mongo" && typeof body.collection === "string" &&
        body.collection.startsWith("histogram_") && body.action === "find"
      ) {
        await json([]);
        return;
      }
      blocked.push(
        `${resource}:${String(body.action)}:${String(body.collection ?? "")}`,
      );
      await json(
        { error: "Unmatched API request denied by smoke fixture" },
        501,
      );
      return;
    }
    if (
      /^\/(api|auth|oauth|data)(\/|$)/.test(url.pathname) ||
      request.method() !== "GET" || request.resourceType() === "fetch" ||
      request.resourceType() === "xhr"
    ) {
      blocked.push(`${request.method()} ${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    // Only frontend navigation/assets reach this isolated Vite process.
    await route.continue();
  });
  await page.routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url());
    if (url.host === "127.0.0.1:43117" && url.pathname === "/ws") {
      socket.send(JSON.stringify({ type: "ready" }));
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "subscribe") {
          socket.send(
            JSON.stringify({ type: "subscribed", channel: message.channel }),
          );
        }
        if (message.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }));
        }
      });
    } else if (
      ["127.0.0.1:43117", "localhost:43117"].includes(url.host) &&
      url.pathname === "/"
    ) {
      socket.connectToServer(); // Vite HMR only.
    } else {
      blocked.push(`WebSocket ${url.origin}${url.pathname}`);
      socket.close();
    }
  });
}

export const test = base.extend<{ backend: MockBackend }>({
  backend: [async ({ page }, use) => {
    const blocked: string[] = [];
    const state: MockBackend = { requests: [], chatUnavailable: false };
    await mockNetwork(page, state, blocked);
    await use(state);
    expect(
      blocked,
      "Every backend/external request must have an explicit fictional fixture",
    ).toEqual([]);
  }, { auto: true }],
});
export { expect };
