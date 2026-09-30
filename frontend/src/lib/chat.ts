import { ObjectId } from "bson";
import type { UIMessage } from "ai";
import type {
  ChatRunState,
  ChatSummary,
  ChatToolPolicy,
} from "@myceliasdk/messengers.ts";

export interface ChatMessageMetadata {
  requestedModel?: string;
  model?: string;
  providerProfileId?: string;
  providerProfileName?: string;
  requestId?: string;
  runId?: string;
  finishReason?: string;
  startedAt?: string;
  durationMs?: number;
  usage?: Record<string, number | undefined>;
  pinnedAt?: Date | string;
  error?: { type?: string; message?: string };
}

export type MemoryChatMessage = UIMessage<ChatMessageMetadata> & {
  content?: unknown;
  createdAt?: Date;
};

export type MemoryChatSummary = ChatSummary;

export interface ChatRunEvent {
  chatId: string;
  runId: string;
  state: ChatRunState;
  updatedAt: string;
  error?: string;
}

export const DEFAULT_CHAT_TOOL_POLICY: ChatToolPolicy = {
  mode: "auto",
  enabledTools: [],
};

export function createDraftChatId(): string {
  return new ObjectId().toString();
}

export function messageText(message: MemoryChatMessage): string {
  return (message.parts ?? [])
    .filter((part: any) => part?.type === "text" && part?.text)
    .map((part: any) => part.text)
    .join("\n\n");
}

export function hasRenderableAssistantOutput(
  message: MemoryChatMessage,
): boolean {
  if (typeof message.content === "string" && message.content.trim()) {
    return true;
  }
  return message.parts?.some((part: any) => {
    if (part?.type === "text") return Boolean(part.text?.trim());
    return part?.type?.startsWith("tool-") || part?.type === "dynamic-tool";
  }) ?? false;
}

export function messageNeedsApproval(message?: MemoryChatMessage): boolean {
  return message?.parts?.some((part: any) =>
    part?.state === "approval-requested" && part?.approval?.id
  ) ?? false;
}

export function chatStatusLabel(
  sdkStatus: "submitted" | "streaming" | "ready" | "error",
  lastRun?: { state?: ChatRunState },
  hasApproval = false,
): string {
  if (hasApproval || lastRun?.state === "needs_approval") {
    return "Needs approval";
  }
  if (sdkStatus === "submitted") return "Sending";
  if (sdkStatus === "streaming") return "Answering";
  if (sdkStatus === "error" || lastRun?.state === "failed") return "Error";
  if (lastRun?.state === "cancelled") return "Stopped";
  if (lastRun?.state === "interrupted") return "Interrupted";
  return "Ready";
}

export function isChatRunActive(state?: ChatRunState): boolean {
  return state === "submitted" || state === "streaming" ||
    state === "needs_approval";
}

export function isNearBottom(element: HTMLElement, threshold = 120): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <=
    threshold;
}

export function shouldNotifyForChatEvent(options: {
  state: ChatRunState;
  eventChatId: string;
  activeChatId?: string;
  documentHidden: boolean;
}): boolean {
  const terminalOrAction = [
    "completed",
    "failed",
    "needs_approval",
    "interrupted",
  ].includes(options.state);
  if (!terminalOrAction) return false;
  return options.documentHidden || options.eventChatId !== options.activeChatId;
}
