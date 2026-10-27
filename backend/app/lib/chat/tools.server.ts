import type { Tool } from "ai";
import type { Auth } from "@/lib/auth/core.server.ts";
import { defaultResourceManager } from "@/lib/auth/resources.ts";
import {
  createAiSdkToolsFromResources,
  createMCPToolsFromResources,
} from "@/lib/mcp/ai-sdk-adapter.ts";
import type {
  ChatToolCatalogEntry,
  ChatToolPolicy,
} from "@myceliasdk/messengers.ts";
import { aggregateResourceActions } from "@/lib/mongo/pipeline-policy.ts";

export function validateChatToolInput(toolName: string, input: unknown): void {
  if (toolName !== "mongo_aggregate") return;
  const aggregate = input as {
    collection: string;
    pipeline: Record<string, unknown>[];
  };
  aggregateResourceActions(aggregate.collection, aggregate.pipeline, true);
}

export const CHAT_AI_RESOURCE_CODES = [
  "search",
  "rag",
  "objects",
  "docs",
  "mongo",
];

export const CHAT_TOOLS_REQUIRING_APPROVAL = [
  "objects_create",
  "objects_update",
  "objects_delete",
  "objects_merge",
  "objects_split",
];

const MONGO_READONLY_TOOLS = new Set([
  "mongo_find",
  "mongo_findOne",
  "mongo_aggregate",
  "mongo_count",
  "mongo_listIndexes",
  "mongo_getFirstBatch",
  "mongo_getMore",
]);

const CHAT_EXCLUDED_TOOLS = new Set([
  "objects_claimSummarization",
  "objects_releaseSummarization",
  // This is an internal repair operation that mutates catalog state and was
  // previously exposed without an approval boundary.
  "objects_repairListCatalog",
]);

export const chatToolFilter = (name: string): boolean =>
  !CHAT_EXCLUDED_TOOLS.has(name) &&
  (!name.startsWith("rag_") || name === "rag_search") &&
  (!name.startsWith("mongo_") || MONGO_READONLY_TOOLS.has(name));

export function isRagChatEnabled(ragUrl = Deno.env.get("RAG_URL")): boolean {
  return Boolean(ragUrl?.trim());
}

function chatResources() {
  return defaultResourceManager.listResources().filter((resource) =>
    CHAT_AI_RESOURCE_CODES.includes(resource.code) &&
    (resource.code !== "rag" || isRagChatEnabled())
  );
}

export function createChatTools(auth: Auth): Record<string, Tool> {
  return createAiSdkToolsFromResources(chatResources(), auth, {
    toolsRequiringApproval: CHAT_TOOLS_REQUIRING_APPROVAL,
    toolFilter: chatToolFilter,
    resourceManager: defaultResourceManager,
    validateInput: validateChatToolInput,
  });
}

function toolLabel(name: string): string {
  return name
    .replace(/^[^_]+_/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function toolGroup(
  name: string,
  needsApproval: boolean,
): ChatToolCatalogEntry["group"] {
  if (needsApproval) return "Actions";
  if (name.startsWith("rag_")) return "Search";
  if (name.startsWith("search_")) return "Search";
  if (name.startsWith("docs_")) return "Docs";
  if (name.startsWith("mongo_")) return "Advanced data";
  return "Knowledge";
}

export function listChatTools(auth: Auth): ChatToolCatalogEntry[] {
  const tools = createMCPToolsFromResources(chatResources(), auth, {
    toolsRequiringApproval: CHAT_TOOLS_REQUIRING_APPROVAL,
    toolFilter: chatToolFilter,
    resourceManager: defaultResourceManager,
    validateInput: validateChatToolInput,
  });

  return Object.entries(tools).map(([name, tool]) => {
    const needsApproval = tool.needsApproval === true;
    return {
      name,
      label: toolLabel(name),
      description: tool.description,
      group: toolGroup(name, needsApproval),
      needsApproval,
      defaultEnabled: true,
    };
  }).sort((left, right) =>
    left.group.localeCompare(right.group) ||
    left.label.localeCompare(right.label)
  );
}

export function normalizeChatToolPolicy(
  policy: Partial<ChatToolPolicy> | null | undefined,
  availableToolNames: Iterable<string>,
): ChatToolPolicy {
  const mode = policy?.mode ?? "auto";
  if (mode !== "auto" && mode !== "none" && mode !== "custom") {
    throw new Error(`Unknown chat tool mode: ${String(mode)}`);
  }

  if (mode !== "custom") {
    return { mode, enabledTools: [] };
  }

  const available = new Set(availableToolNames);
  const enabledTools = [...new Set(policy?.enabledTools ?? [])];
  const unknown = enabledTools.filter((name) => !available.has(name));
  if (unknown.length > 0) {
    throw new Error(`Unavailable chat tools: ${unknown.join(", ")}`);
  }

  return { mode, enabledTools };
}

export function activeToolsForPolicy(
  policy: ChatToolPolicy,
  tools: Record<string, Tool>,
): string[] | undefined {
  if (policy.mode === "auto") return undefined;
  if (policy.mode === "none") return [];
  return policy.enabledTools.filter((name) => name in tools);
}
