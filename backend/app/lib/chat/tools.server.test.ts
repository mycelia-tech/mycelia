import { expect } from "@std/expect";
import { ObjectId } from "bson";
import {
  activeToolsForPolicy,
  chatToolFilter,
  decodeChatToolInput,
  isRagChatEnabled,
  normalizeChatToolPolicy,
  validateChatToolInput,
} from "./tools.server.ts";
import { accessLogger, Auth } from "@/lib/auth/core.server.ts";
import { ResourceManager } from "@/lib/auth/resources.ts";
import { MongoResource } from "@/lib/mongo/core.server.ts";
import { resourceToTools } from "@/lib/mcp/ai-sdk-adapter.ts";

Deno.test("chat tool policy keeps Auto distinct from No tools", () => {
  expect(normalizeChatToolPolicy(undefined, ["search_find"])).toEqual({
    mode: "auto",
    enabledTools: [],
  });
  expect(normalizeChatToolPolicy({ mode: "none" }, ["search_find"]))
    .toEqual({ mode: "none", enabledTools: [] });
  expect(activeToolsForPolicy({ mode: "none", enabledTools: [] }, {}))
    .toEqual([]);
});

Deno.test("RAG chat tool is exposed only when the standalone runtime is configured", () => {
  expect(isRagChatEnabled(undefined)).toBe(false);
  expect(isRagChatEnabled("   ")).toBe(false);
  expect(isRagChatEnabled("http://host.docker.internal:48091")).toBe(true);
});

Deno.test("custom chat tools reject unavailable names", () => {
  expect(() =>
    normalizeChatToolPolicy(
      { mode: "custom", enabledTools: ["mongo_deleteOne"] },
      ["mongo_find"],
    )
  ).toThrow("Unavailable chat tools");
});

Deno.test("chat tool filter excludes writes and internal repairs", () => {
  expect(chatToolFilter("mongo_find")).toBe(true);
  expect(chatToolFilter("mongo_updateOne")).toBe(false);
  expect(chatToolFilter("objects_repairListCatalog")).toBe(false);
  expect(chatToolFilter("objects_create")).toBe(true);
  expect(chatToolFilter("rag_search")).toBe(true);
  expect(chatToolFilter("rag_status")).toBe(false);
  expect(chatToolFilter("rag_rebuild")).toBe(false);
});

Deno.test("chat aggregate cannot write even with root authorization", async () => {
  const manager = new ResourceManager();
  const mongo = new MongoResource();
  let calls = 0;
  mongo.use = async () => {
    calls++;
    return [];
  };
  manager.registerResource(mongo);
  const auth = new Auth({
    principal: "root",
    policies: [{ resource: "**", action: "*", effect: "allow" }],
  });
  const tools = resourceToTools(mongo, auth, {
    resourceManager: manager,
    decodeInput: decodeChatToolInput,
    validateInput: validateChatToolInput,
  });
  for (
    const pipeline of [[{ $out: "target" }], [{ $merge: { into: "target" } }], [
      { $facet: { nested: [{ $merge: { into: "target" } }] } },
    ]]
  ) {
    await expect(
      tools.mongo_aggregate.execute({ collection: "public", pipeline }),
    ).rejects.toBeInstanceOf(Response);
  }
  expect(calls).toBe(0);
  const original = accessLogger.log;
  accessLogger.log = async () => {};
  try {
    await tools.mongo_aggregate.execute({
      collection: "public",
      pipeline: [{ $match: { ok: true } }],
    });
    expect(calls).toBe(1);
  } finally {
    accessLogger.log = original;
  }
});

Deno.test("chat Mongo tool decodes Extended JSON dates and IDs before execution", async () => {
  const manager = new ResourceManager();
  const mongo = new MongoResource();
  let query: unknown;
  mongo.use = async (input) => {
    if (input.action === "findOne") query = input.query;
    return null;
  };
  manager.registerResource(mongo);
  const id = new ObjectId();
  const start = new Date("2025-06-22T00:00:00.000Z");
  const tools = resourceToTools(
    mongo,
    new Auth({
      principal: "root",
      policies: [{ resource: "**", action: "*", effect: "allow" }],
    }),
    {
      resourceManager: manager,
      decodeInput: decodeChatToolInput,
      validateInput: validateChatToolInput,
    },
  );
  const original = accessLogger.log;
  accessLogger.log = async () => {};
  try {
    await tools.mongo_findOne.execute({
      collection: "transcriptions",
      query: {
        _id: { $oid: id.toHexString() },
        start: { $gte: { $date: start.toISOString() } },
      },
    });
    expect(query).toEqual({ _id: id, start: { $gte: start } });
  } finally {
    accessLogger.log = original;
  }
});
