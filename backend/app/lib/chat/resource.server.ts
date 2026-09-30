import { ObjectId } from "bson";
import { z } from "zod";
import type { Auth } from "@/lib/auth/core.server.ts";
import type { Resource } from "@/lib/auth/resources.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import {
  publishChatRunChanged,
  publishChatUpdated,
} from "@/lib/chat/events.server.ts";
import {
  listChatTools,
  normalizeChatToolPolicy,
} from "@/lib/chat/tools.server.ts";
import type {
  ChatRunState,
  ChatSummary,
  ChatToolPolicy,
} from "@myceliasdk/messengers.ts";

const ACTIVE_RUN_STATES: ChatRunState[] = ["submitted", "streaming"];
const TOOL_POLICY_LOCK_STATES: ChatRunState[] = [
  ...ACTIVE_RUN_STATES,
  "needs_approval",
];
const UNREAD_RUN_STATES: ChatRunState[] = [
  "needs_approval",
  "completed",
  "failed",
  "interrupted",
];
const STALE_RUN_MS = 30 * 60 * 1000;

const zObjectIdInput = z.union([
  z.instanceof(ObjectId),
  z.string().refine(ObjectId.isValid, "Invalid ObjectId"),
]).transform((value) =>
  value instanceof ObjectId ? value : new ObjectId(value)
);

const zToolPolicyInput = z.object({
  mode: z.enum(["auto", "none", "custom"]),
  enabledTools: z.array(z.string().min(1).max(160)).max(100).default([]),
});

const zPreferencesInput = z.object({
  model: z.string().trim().min(1).max(200).optional(),
  providerProfileId: z.string().trim().min(1).max(120).nullable().optional(),
  toolPolicy: zToolPolicyInput.optional(),
});

const chatRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    cursor: z.string().regex(/^\d+$/).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    query: z.string().trim().max(160).optional(),
    favoritesOnly: z.boolean().default(false),
    archivedOnly: z.boolean().default(false),
  }),
  z.object({ action: z.literal("getMessages"), chatId: zObjectIdInput }),
  z.object({
    action: z.literal("createDraft"),
    chatId: zObjectIdInput,
    initialText: z.string().max(20_000),
    preferences: zPreferencesInput.optional(),
  }),
  z.object({
    action: z.literal("rename"),
    chatId: zObjectIdInput,
    title: z.string().trim().min(1).max(160),
  }),
  z.object({
    action: z.literal("setFavorite"),
    chatId: zObjectIdInput,
    favorite: z.boolean(),
  }),
  z.object({
    action: z.literal("setArchived"),
    chatId: zObjectIdInput,
    archived: z.boolean(),
  }),
  z.object({
    action: z.literal("setPreferences"),
    chatId: zObjectIdInput,
    preferences: zPreferencesInput,
  }),
  z.object({
    action: z.literal("setMessagePinned"),
    chatId: zObjectIdInput,
    messageId: zObjectIdInput,
    pinned: z.boolean(),
  }),
  z.object({ action: z.literal("markRead"), chatId: zObjectIdInput }),
  z.object({ action: z.literal("listTools") }),
]);

export type ChatResourceRequest = z.infer<typeof chatRequestSchema>;

type MongoCaller = (request: any) => Promise<any>;
type MongoFactory = (auth: Auth) => MongoCaller;
type ChatUpdatePublisher = typeof publishChatUpdated;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function provisionalChatTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "New Chat";
  if (normalized.length <= 80) return normalized;
  return `${normalized.slice(0, 77).trimEnd()}…`;
}

export function chatToolPolicyFromDocument(chat: any): ChatToolPolicy {
  const mode = chat?.toolMode === "none" || chat?.toolMode === "custom"
    ? chat.toolMode
    : "auto";
  return {
    mode,
    enabledTools: mode === "custom" && Array.isArray(chat?.enabledTools)
      ? chat.enabledTools.filter((name: unknown): name is string =>
        typeof name === "string"
      )
      : [],
  };
}

export function chatToolPoliciesEqual(
  left: ChatToolPolicy,
  right: ChatToolPolicy,
): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode !== "custom") return true;
  if (left.enabledTools.length !== right.enabledTools.length) return false;
  const enabled = new Set(left.enabledTools);
  return right.enabledTools.every((name) => enabled.has(name));
}

export function chatDocumentToSummary(chat: any): ChatSummary {
  const policy = chatToolPolicyFromDocument(chat);
  const lastReadAt = chat.lastReadAt ? new Date(chat.lastReadAt) : undefined;
  const runUpdatedAt = chat.lastRun?.updatedAt
    ? new Date(chat.lastRun.updatedAt)
    : undefined;
  const unread = Boolean(
    chat.lastRun?.state &&
      UNREAD_RUN_STATES.includes(chat.lastRun.state) &&
      runUpdatedAt && (!lastReadAt || runUpdatedAt > lastReadAt),
  );

  return {
    ...chat,
    messageCount: Number.isFinite(chat.messageCount) ? chat.messageCount : 0,
    pinnedMessageCount: Number.isFinite(chat.pinnedMessageCount)
      ? Math.max(0, chat.pinnedMessageCount)
      : 0,
    toolMode: policy.mode,
    enabledTools: policy.enabledTools,
    unread,
  } as ChatSummary;
}

async function findOwnedChat(
  mongo: MongoCaller,
  principal: string,
  chatId: ObjectId,
): Promise<any | null> {
  return await mongo({
    action: "findOne",
    collection: "chats",
    query: { _id: chatId, userId: principal, platform: "mycelia" },
  });
}

async function reconcileStaleRuns(
  mongo: MongoCaller,
  principal: string,
): Promise<void> {
  const staleRuns = await mongo({
    action: "find",
    collection: "chat_runs",
    query: {
      userId: principal,
      state: { $in: ACTIVE_RUN_STATES },
      updatedAt: { $lt: new Date(Date.now() - STALE_RUN_MS) },
    },
    options: { limit: 100, sort: { updatedAt: 1 } },
  });

  for (const run of staleRuns as any[]) {
    const now = new Date();
    const error = "The response was interrupted before completion";
    const update = await mongo({
      action: "updateOne",
      collection: "chat_runs",
      query: { _id: run._id, state: { $in: ACTIVE_RUN_STATES } },
      update: {
        $set: { state: "interrupted", error, updatedAt: now, finishedAt: now },
      },
    });
    if (!update?.modifiedCount) continue;

    const chatUpdate = await mongo({
      action: "updateOne",
      collection: "chats",
      query: {
        _id: run.chatId,
        userId: principal,
        platform: "mycelia",
        activeRunId: run.runId,
      },
      update: {
        $set: {
          lastRun: {
            runId: run.runId,
            state: "interrupted",
            startedAt: run.startedAt,
            updatedAt: now,
            finishedAt: now,
            error,
          },
        },
        $unset: { activeRunId: "" },
      },
    });
    if (!chatUpdate?.matchedCount) continue;
    await publishChatRunChanged(
      principal,
      run.chatId.toString(),
      run.runId,
      "interrupted",
      error,
    );
  }
}

export class ChatResource implements Resource<ChatResourceRequest, any> {
  code = "chat";
  description = "Authenticated operations for Mycelia AI chats";
  schemas = { request: chatRequestSchema, response: z.any() };

  constructor(
    private readonly mongoFactory: MongoFactory = getMongoResource,
    private readonly publishUpdated: ChatUpdatePublisher = publishChatUpdated,
  ) {}

  extractActions(input: ChatResourceRequest) {
    const readActions = new Set(["list", "getMessages", "listTools"]);
    return [{
      path: ["chat", readActions.has(input.action) ? "read" : "write"],
      actions: [readActions.has(input.action) ? "read" : "write"],
    }];
  }

  async use(input: ChatResourceRequest, auth: Auth): Promise<any> {
    if (input.action === "listTools") {
      return { tools: listChatTools(auth) };
    }

    const mongo = this.mongoFactory(auth);

    if (input.action === "list") {
      await reconcileStaleRuns(mongo, auth.principal);
      const baseQuery: Record<string, unknown> = {
        userId: auth.principal,
        platform: "mycelia",
        archivedAt: input.archivedOnly ? { $type: "date" } : { $exists: false },
      };
      if (input.query) {
        const pattern = escapeRegex(input.query);
        baseQuery.$or = [
          { title: { $regex: pattern, $options: "i" } },
          { name: { $regex: pattern, $options: "i" } },
        ];
      }
      const offset = Number(input.cursor ?? 0);
      const findChats = async (
        favorite: boolean,
        skip: number,
        limit: number,
      ): Promise<any[]> => {
        if (limit <= 0) return [];
        return await mongo({
          action: "find",
          collection: "chats",
          query: {
            ...baseQuery,
            favoritedAt: favorite ? { $type: "date" } : { $exists: false },
          },
          options: {
            sort: { lastMessageDate: -1, _id: -1 },
            skip,
            limit,
            projection: { raw: 0 },
          },
        }) as any[];
      };

      let chats: any[];
      if (input.favoritesOnly) {
        chats = await findChats(true, offset, input.limit);
      } else {
        const favoriteCount = await mongo({
          action: "count",
          collection: "chats",
          query: { ...baseQuery, favoritedAt: { $type: "date" } },
        }) as number;
        const favoriteSkip = Math.min(offset, favoriteCount);
        const favorites = await findChats(
          true,
          favoriteSkip,
          input.limit,
        );
        const recentSkip = Math.max(0, offset - favoriteCount);
        const recent = await findChats(
          false,
          recentSkip,
          input.limit - favorites.length,
        );
        chats = [...favorites, ...recent];
      }
      return {
        items: chats.map(chatDocumentToSummary),
        nextCursor: chats.length === input.limit
          ? String(offset + chats.length)
          : undefined,
      };
    }

    if (input.action === "getMessages") {
      await reconcileStaleRuns(mongo, auth.principal);
      const chat = await findOwnedChat(mongo, auth.principal, input.chatId);
      if (!chat) return { found: false, chat: null, messages: [] };
      const messages = await mongo({
        action: "find",
        collection: "messages",
        query: { chatId: input.chatId },
        options: { sort: { timestamp: 1, createdAt: 1, _id: 1 } },
      });
      return { found: true, chat: chatDocumentToSummary(chat), messages };
    }

    if (input.action === "createDraft") {
      const existing = await mongo({
        action: "findOne",
        collection: "chats",
        query: { _id: input.chatId },
      });
      if (existing) {
        if (
          existing.userId !== auth.principal || existing.platform !== "mycelia"
        ) {
          throw new Error("Chat ID is already in use");
        }
        return { created: false, chat: chatDocumentToSummary(existing) };
      }

      const catalog = listChatTools(auth);
      const toolPolicy = normalizeChatToolPolicy(
        input.preferences?.toolPolicy,
        catalog.map((tool) => tool.name),
      );
      const now = new Date();
      const title = provisionalChatTitle(input.initialText);
      const doc = {
        _id: input.chatId,
        userId: auth.principal,
        title,
        name: title,
        titleSource: "provisional",
        ...(input.preferences?.model ? { model: input.preferences.model } : {}),
        ...(input.preferences?.providerProfileId
          ? { providerProfileId: input.preferences.providerProfileId }
          : {}),
        toolMode: toolPolicy.mode,
        enabledTools: toolPolicy.enabledTools,
        messageCount: 0,
        pinnedMessageCount: 0,
        platform: "mycelia",
        externalId: input.chatId.toString(),
        type: "private",
        createdAt: now,
        updatedAt: now,
        lastMessageDate: now,
      };
      await mongo({ action: "insertOne", collection: "chats", doc });
      await this.publishUpdated(
        auth.principal,
        input.chatId.toString(),
        "created",
      );
      return { created: true, chat: chatDocumentToSummary(doc) };
    }

    const chat = await findOwnedChat(mongo, auth.principal, input.chatId);
    if (!chat) throw new Error("Chat not found or access denied");

    if (input.action === "rename") {
      await mongo({
        action: "updateOne",
        collection: "chats",
        query: {
          _id: input.chatId,
          userId: auth.principal,
          platform: "mycelia",
        },
        update: {
          $set: { title: input.title, name: input.title, titleSource: "user" },
        },
      });
      await this.publishUpdated(
        auth.principal,
        input.chatId.toString(),
        "renamed",
      );
      return { title: input.title };
    }

    if (input.action === "setFavorite") {
      const favoritedAt = input.favorite ? new Date() : undefined;
      await mongo({
        action: "updateOne",
        collection: "chats",
        query: {
          _id: input.chatId,
          userId: auth.principal,
          platform: "mycelia",
        },
        update: input.favorite
          ? { $set: { favoritedAt } }
          : { $unset: { favoritedAt: "" } },
      });
      await this.publishUpdated(
        auth.principal,
        input.chatId.toString(),
        "favorite",
      );
      return { favoritedAt };
    }

    if (input.action === "setArchived") {
      if (
        input.archived && chat.lastRun?.state &&
        TOOL_POLICY_LOCK_STATES.includes(chat.lastRun.state)
      ) {
        throw new Error("An active chat cannot be archived");
      }
      const archivedAt = input.archived ? new Date() : undefined;
      await mongo({
        action: "updateOne",
        collection: "chats",
        query: {
          _id: input.chatId,
          userId: auth.principal,
          platform: "mycelia",
        },
        update: input.archived
          ? { $set: { archivedAt } }
          : { $unset: { archivedAt: "" } },
      });
      await this.publishUpdated(
        auth.principal,
        input.chatId.toString(),
        input.archived ? "archived" : "restored",
      );
      return { archivedAt };
    }

    if (input.action === "setPreferences") {
      let requestedToolPolicy: ChatToolPolicy | undefined;
      let toolPolicyChanged = false;
      if (input.preferences.toolPolicy) {
        const catalog = listChatTools(auth);
        requestedToolPolicy = normalizeChatToolPolicy(
          input.preferences.toolPolicy,
          catalog.map((tool) => tool.name),
        );
        toolPolicyChanged = !chatToolPoliciesEqual(
          chatToolPolicyFromDocument(chat),
          requestedToolPolicy,
        );
      }
      if (
        toolPolicyChanged &&
        chat.lastRun?.state &&
        TOOL_POLICY_LOCK_STATES.includes(chat.lastRun.state)
      ) {
        throw new Error(
          "Tool selection cannot change while a response is active",
        );
      }
      const set: Record<string, unknown> = {};
      const unset: Record<string, string> = {};
      if (input.preferences.model) set.model = input.preferences.model;
      if (input.preferences.providerProfileId === null) {
        unset.providerProfileId = "";
      } else if (input.preferences.providerProfileId) {
        set.providerProfileId = input.preferences.providerProfileId;
      }
      if (requestedToolPolicy && toolPolicyChanged) {
        set.toolMode = requestedToolPolicy.mode;
        set.enabledTools = requestedToolPolicy.enabledTools;
      }
      if (Object.keys(set).length || Object.keys(unset).length) {
        await mongo({
          action: "updateOne",
          collection: "chats",
          query: {
            _id: input.chatId,
            userId: auth.principal,
            platform: "mycelia",
          },
          update: {
            ...(Object.keys(set).length ? { $set: set } : {}),
            ...(Object.keys(unset).length ? { $unset: unset } : {}),
          },
        });
        await this.publishUpdated(
          auth.principal,
          input.chatId.toString(),
          "preferences",
        );
      }
      return { updated: true };
    }

    if (input.action === "setMessagePinned") {
      const message = await mongo({
        action: "findOne",
        collection: "messages",
        query: { _id: input.messageId, chatId: input.chatId },
        options: { projection: { _id: 1 } },
      });
      if (!message) throw new Error("Message not found in this chat");
      const pinnedAt = input.pinned ? new Date() : undefined;
      const update = await mongo({
        action: "updateOne",
        collection: "messages",
        query: {
          _id: input.messageId,
          chatId: input.chatId,
          pinnedAt: input.pinned ? { $exists: false } : { $type: "date" },
        },
        update: input.pinned
          ? { $set: { pinnedAt } }
          : { $unset: { pinnedAt: "" } },
      });
      if (update?.modifiedCount) {
        await mongo({
          action: "updateOne",
          collection: "chats",
          query: {
            _id: input.chatId,
            userId: auth.principal,
            platform: "mycelia",
          },
          update: { $inc: { pinnedMessageCount: input.pinned ? 1 : -1 } },
        });
        if (!input.pinned) {
          await mongo({
            action: "updateOne",
            collection: "chats",
            query: {
              _id: input.chatId,
              userId: auth.principal,
              platform: "mycelia",
            },
            update: { $max: { pinnedMessageCount: 0 } },
          });
        }
      }
      await this.publishUpdated(
        auth.principal,
        input.chatId.toString(),
        "pin",
      );
      return { pinnedAt, changed: Boolean(update?.modifiedCount) };
    }

    if (input.action === "markRead") {
      const lastReadAt = new Date();
      await mongo({
        action: "updateOne",
        collection: "chats",
        query: {
          _id: input.chatId,
          userId: auth.principal,
          platform: "mycelia",
        },
        update: { $set: { lastReadAt } },
      });
      return { lastReadAt };
    }

    throw new Error("Unsupported chat action");
  }
}
