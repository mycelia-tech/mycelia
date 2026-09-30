import { expect } from "@std/expect";
import { ObjectId } from "bson";
import { Auth } from "@/lib/auth/core.server.ts";
import {
  chatDocumentToSummary,
  ChatResource,
  provisionalChatTitle,
} from "./resource.server.ts";

Deno.test("provisional chat title is normalized and bounded", () => {
  expect(provisionalChatTitle("  hello\n   world  ")).toBe("hello world");
  const title = provisionalChatTitle("x".repeat(120));
  expect(title.length).toBe(78);
  expect(title.endsWith("…")).toBe(true);
});

Deno.test("chat summary separates selected and actual response models", () => {
  const now = new Date();
  const summary = chatDocumentToSummary({
    _id: new ObjectId(),
    model: "medium",
    lastResponseModel: "qwen-local-32b",
    messageCount: 4,
    lastRun: { runId: "run-1", state: "completed", updatedAt: now },
  });
  expect(summary.model).toBe("medium");
  expect(summary.lastResponseModel).toBe("qwen-local-32b");
  expect(summary.unread).toBe(true);
  expect(summary.toolMode).toBe("auto");
  expect(summary.pinnedMessageCount).toBe(0);
});

Deno.test("getMessages scopes the chat lookup to the authenticated owner", async () => {
  const chatId = new ObjectId();
  const calls: any[] = [];
  const resource = new ChatResource(() => async (request: any) => {
    calls.push(request);
    if (request.collection === "chat_runs") return [];
    if (request.collection === "chats" && request.action === "findOne") {
      return null;
    }
    throw new Error(`Unexpected request ${request.action}`);
  });
  const auth = new Auth({ principal: "owner-a", policies: [] });
  const result = await resource.use({ action: "getMessages", chatId }, auth);
  expect(result).toEqual({ found: false, chat: null, messages: [] });
  const lookup = calls.find((request) =>
    request.collection === "chats" && request.action === "findOne"
  );
  expect(lookup.query).toEqual({
    _id: chatId,
    userId: "owner-a",
    platform: "mycelia",
  });
});

Deno.test("chat mutations stop at the shared ownership check", async () => {
  const chatId = new ObjectId();
  const messageId = new ObjectId();
  const actions = [
    { action: "rename", chatId, title: "Renamed" },
    { action: "setFavorite", chatId, favorite: true },
    { action: "setArchived", chatId, archived: true },
    {
      action: "setPreferences",
      chatId,
      preferences: { toolPolicy: { mode: "none", enabledTools: [] } },
    },
    { action: "setMessagePinned", chatId, messageId, pinned: true },
    { action: "markRead", chatId },
  ];

  for (const input of actions) {
    const calls: any[] = [];
    const resource = new ChatResource(() => async (request: any) => {
      calls.push(request);
      return null;
    });
    const auth = new Auth({ principal: "owner-a", policies: [] });
    await expect(resource.use(input as any, auth)).rejects.toThrow(
      "Chat not found or access denied",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toEqual({
      _id: chatId,
      userId: "owner-a",
      platform: "mycelia",
    });
  }
});

Deno.test("chat list groups favorites first and sorts each group by freshness", async () => {
  const favoriteNew = {
    _id: new ObjectId(),
    name: "Favorite new",
    favoritedAt: new Date("2026-08-01T00:00:00Z"),
    lastMessageDate: new Date("2026-08-18T12:00:00Z"),
    messageCount: 2,
  };
  const favoriteOld = {
    _id: new ObjectId(),
    name: "Favorite old",
    favoritedAt: new Date("2026-08-17T00:00:00Z"),
    lastMessageDate: new Date("2026-08-10T12:00:00Z"),
    messageCount: 1,
  };
  const recent = {
    _id: new ObjectId(),
    name: "Recent",
    lastMessageDate: new Date("2026-08-18T13:00:00Z"),
    messageCount: 4,
  };
  const calls: any[] = [];
  const resource = new ChatResource(() => async (request: any) => {
    calls.push(request);
    if (request.collection === "chat_runs") return [];
    if (request.action === "count") return 2;
    if (request.query.favoritedAt.$type === "date") {
      return [favoriteNew, favoriteOld];
    }
    return [recent];
  });
  const auth = new Auth({ principal: "owner-a", policies: [] });
  const result = await resource.use({
    action: "list",
    limit: 3,
    favoritesOnly: false,
    archivedOnly: false,
  }, auth);

  expect(result.items.map((chat: any) => chat.name)).toEqual([
    "Favorite new",
    "Favorite old",
    "Recent",
  ]);
  const chatFinds = calls.filter((request) =>
    request.collection === "chats" && request.action === "find"
  );
  expect(chatFinds).toHaveLength(2);
  expect(chatFinds[0].options.sort).toEqual({
    lastMessageDate: -1,
    _id: -1,
  });
  expect(
    chatFinds.every((request) => request.query.archivedAt.$exists === false),
  ).toBe(true);
});

Deno.test("archived chat list uses a separate ownership-scoped view", async () => {
  const calls: any[] = [];
  const resource = new ChatResource(() => async (request: any) => {
    calls.push(request);
    if (request.collection === "chat_runs") return [];
    if (request.collection === "chats" && request.action === "find") return [];
    throw new Error(`Unexpected request ${request.action}`);
  });
  const auth = new Auth({ principal: "owner-a", policies: [] });
  await resource.use({
    action: "list",
    limit: 20,
    favoritesOnly: true,
    archivedOnly: true,
  }, auth);

  const lookup = calls.find((request) =>
    request.collection === "chats" && request.action === "find"
  );
  expect(lookup.query).toMatchObject({
    userId: "owner-a",
    platform: "mycelia",
    archivedAt: { $type: "date" },
  });
});

Deno.test("an active response prevents archiving", async () => {
  const chatId = new ObjectId();
  const resource = new ChatResource(() => async (request: any) => {
    if (request.collection === "chats" && request.action === "findOne") {
      return {
        _id: chatId,
        userId: "owner-a",
        platform: "mycelia",
        lastRun: { state: "streaming" },
      };
    }
    throw new Error(`Unexpected request ${request.action}`);
  });
  const auth = new Auth({ principal: "owner-a", policies: [] });

  await expect(resource.use({
    action: "setArchived",
    chatId,
    archived: true,
  }, auth)).rejects.toThrow("An active chat cannot be archived");
});

Deno.test("an active response rejects a different tool policy", async () => {
  const chatId = new ObjectId();
  const resource = new ChatResource(() => async (request: any) => {
    if (request.collection === "chats" && request.action === "findOne") {
      return {
        _id: chatId,
        userId: "owner-a",
        platform: "mycelia",
        toolMode: "auto",
        enabledTools: [],
        lastRun: { state: "streaming" },
      };
    }
    throw new Error(`Unexpected request ${request.action}`);
  });
  const auth = new Auth({ principal: "owner-a", policies: [] });

  await expect(resource.use({
    action: "setPreferences",
    chatId,
    preferences: { toolPolicy: { mode: "none", enabledTools: [] } },
  }, auth)).rejects.toThrow(
    "Tool selection cannot change while a response is active",
  );
});

Deno.test("an active response accepts the same tool policy as a no-op", async () => {
  const chatId = new ObjectId();
  const calls: any[] = [];
  const resource = new ChatResource(() => async (request: any) => {
    calls.push(request);
    if (request.collection === "chats" && request.action === "findOne") {
      return {
        _id: chatId,
        userId: "owner-a",
        platform: "mycelia",
        toolMode: "none",
        enabledTools: [],
        lastRun: { state: "streaming" },
      };
    }
    throw new Error(`Unexpected request ${request.action}`);
  });
  const auth = new Auth({ principal: "owner-a", policies: [] });

  await expect(resource.use({
    action: "setPreferences",
    chatId,
    preferences: { toolPolicy: { mode: "none", enabledTools: [] } },
  }, auth)).resolves.toEqual({ updated: true });
  expect(calls).toHaveLength(1);
});

Deno.test({
  name: "pin mutations update the materialized count only on transition",
  fn: async () => {
    const chatId = new ObjectId();
    const messageId = new ObjectId();
    const calls: any[] = [];
    const resource = new ChatResource(
      () => async (request: any) => {
        calls.push(request);
        if (request.collection === "chats" && request.action === "findOne") {
          return { _id: chatId, userId: "owner-a", platform: "mycelia" };
        }
        if (
          request.collection === "messages" && request.action === "findOne"
        ) {
          return { _id: messageId };
        }
        if (
          request.collection === "messages" && request.action === "updateOne"
        ) {
          return { modifiedCount: 1 };
        }
        if (
          request.collection === "chats" && request.action === "updateOne"
        ) {
          return { modifiedCount: 1 };
        }
        throw new Error(`Unexpected request ${request.action}`);
      },
      () => Promise.resolve(),
    );
    const auth = new Auth({ principal: "owner-a", policies: [] });
    const result = await resource.use({
      action: "setMessagePinned",
      chatId,
      messageId,
      pinned: true,
    }, auth);

    expect(result.changed).toBe(true);
    const countUpdate = calls.find((request) =>
      request.collection === "chats" && request.action === "updateOne"
    );
    expect(countUpdate.update).toEqual({ $inc: { pinnedMessageCount: 1 } });
    const messageUpdate = calls.find((request) =>
      request.collection === "messages" && request.action === "updateOne"
    );
    expect(messageUpdate.query.pinnedAt).toEqual({ $exists: false });

    const idempotentCalls: any[] = [];
    const idempotentResource = new ChatResource(
      () => async (request: any) => {
        idempotentCalls.push(request);
        if (request.collection === "chats" && request.action === "findOne") {
          return { _id: chatId, userId: "owner-a", platform: "mycelia" };
        }
        if (
          request.collection === "messages" && request.action === "findOne"
        ) {
          return { _id: messageId };
        }
        if (
          request.collection === "messages" && request.action === "updateOne"
        ) {
          return { modifiedCount: 0 };
        }
        throw new Error(`Unexpected request ${request.action}`);
      },
      () => Promise.resolve(),
    );
    const unchanged = await idempotentResource.use({
      action: "setMessagePinned",
      chatId,
      messageId,
      pinned: true,
    }, auth);
    expect(unchanged.changed).toBe(false);
    expect(
      idempotentCalls.some((request) =>
        request.collection === "chats" && request.action === "updateOne"
      ),
    ).toBe(false);
  },
});
