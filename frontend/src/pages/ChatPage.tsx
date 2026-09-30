import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { useChat } from "@ai-sdk/react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSpeechButton,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Loader } from "@/components/ai-elements/loader";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  Check,
  Copy,
  MessageSquare,
  Pin,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { apiClient, callResource } from "@/lib/api";
import { ObjectId } from "bson";
import { createUserUIMessage, dbMessageToUIMessage } from "@/lib/chatMessages";
import { formatToolName } from "@/lib/toolPresentation";
import { myceliaPlatform } from "@/modules/messenger/platforms/mycelia";
import type { Message as MessengerMessage } from "@myceliasdk/messengers.ts";
import type {
  ChatToolCatalogEntry,
  ChatToolPolicy,
} from "@myceliasdk/messengers.ts";
import { cn } from "@/lib/utils";
import { useChatSummaries } from "@/hooks/useChatSummaries";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ChatThreadHeader } from "@/components/chat/ChatThreadHeader";
import { ChatActivity } from "@/components/chat/ChatActivity";
import { ChatPinnedNavigation } from "@/components/chat/ChatPinnedNavigation";
import {
  type ChatMessageMetadata,
  chatStatusLabel,
  DEFAULT_CHAT_TOOL_POLICY,
  hasRenderableAssistantOutput,
  isChatRunActive,
  isNearBottom,
  type MemoryChatMessage,
  type MemoryChatSummary,
  messageNeedsApproval,
  messageText,
} from "@/lib/chat";
import { useStableChatSessionId } from "@/hooks/useStableChatSessionId";
import {
  focusDeepLinkedMessage,
  messageElementId,
  normalizeMessageDeepLinkId,
} from "@/lib/messageDeepLink";

interface ChatErrorState {
  message: string;
  model?: string;
  requestId?: string;
}

interface PendingChatMessage {
  id: string;
  text: string;
}

function isValidObjectId(id: string): boolean {
  return /^[a-fA-F0-9]{24}$/.test(id);
}

function toMessengerMessage(
  message: MemoryChatMessage,
  chatId: string,
): MessengerMessage {
  const id = isValidObjectId(message.id)
    ? new ObjectId(message.id)
    : new ObjectId();
  const timestamp = message.createdAt || new Date();
  return {
    _id: id,
    chatId: isValidObjectId(chatId) ? new ObjectId(chatId) : new ObjectId(),
    senderId: new ObjectId(),
    platform: "mycelia",
    externalId: message.id,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    pinnedAt: message.metadata?.pinnedAt
      ? new Date(message.metadata.pinnedAt)
      : undefined,
    raw: {
      role: message.role,
      content: messageText(message),
      uiMessage: { id: message.id, role: message.role, parts: message.parts },
      ...message.metadata,
    },
  };
}

function ToolApprovalRequest({
  part,
  onApprove,
  onDeny,
}: {
  part: any;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const toolName = part.toolName ||
    (typeof part.type === "string" && part.type.startsWith("tool-")
      ? part.type.slice(5)
      : "Unknown Tool");
  return (
    <div className="flex w-full py-2">
      <div className="flex w-full gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/20">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
        </div>
        <div className="flex-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="mb-2 font-medium text-amber-700 dark:text-amber-400">
            Confirmation required: {formatToolName(toolName)}
          </div>
          <p className="mb-3 text-sm text-muted-foreground">
            Review the exact operation before allowing it to change data.
          </p>
          <pre className="mb-4 max-h-40 overflow-auto rounded bg-background/50 p-2 text-xs">
            {JSON.stringify(part.input || {}, null, 2)}
          </pre>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={onApprove}
              className="bg-green-600 hover:bg-green-700"
            >
              <Check className="mr-1 h-4 w-4" /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onDeny}
              className="border-red-500/50 text-red-500 hover:bg-red-500/10"
            >
              <X className="mr-1 h-4 w-4" /> Deny
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatMessageContent({
  message,
  chatId,
  addToolApprovalResponse,
}: {
  message: MemoryChatMessage;
  chatId: string;
  addToolApprovalResponse?: (
    response: { id: string; approved: boolean },
  ) => void;
}) {
  const messengerMessage = useMemo(
    () => toMessengerMessage(message, chatId),
    [chatId, message],
  );
  const MessageComponent = myceliaPlatform.MessageComponent;
  const approvalRequests =
    message.parts?.filter((part: any) =>
      part?.state === "approval-requested" && part?.approval?.id
    ) ?? [];

  if (
    message.role === "assistant" &&
    !hasRenderableAssistantOutput(message) &&
    !message.metadata?.error
  ) {
    return (
      <div className="flex w-full py-2">
        <div className="flex gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-500/20 via-orange-500/20 to-red-500/20">
            <span role="img" aria-label="Mycelia">🍄</span>
          </div>
          <Loader />
        </div>
      </div>
    );
  }

  return (
    <>
      <MessageComponent message={messengerMessage} />
      {addToolApprovalResponse &&
        approvalRequests.map((part: any) => (
          <ToolApprovalRequest
            key={part.toolCallId || part.approval.id}
            part={part}
            onApprove={() =>
              addToolApprovalResponse({ id: part.approval.id, approved: true })}
            onDeny={() =>
              addToolApprovalResponse({
                id: part.approval.id,
                approved: false,
              })}
          />
        ))}
    </>
  );
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" &&
    globalThis.matchMedia("(max-width: 767px)").matches
  );
  useEffect(() => {
    const query = globalThis.matchMedia("(max-width: 767px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}

export default function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const params = useParams();
  const navigate = useNavigate();
  const routeChatId = params.chatId ?? searchParams.get("id") ?? undefined;
  const requestedMessageId = searchParams.get("messageId");
  const linkedMessageId = normalizeMessageDeepLinkId(requestedMessageId);
  const { chatSessionId: effectiveChatId, resetDraft } = useStableChatSessionId(
    routeChatId,
  );
  const isMobile = useIsMobile();

  const [query, setQuery] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [archivedOnly, setArchivedOnly] = useState(false);
  const chatList = useChatSummaries(query, favoritesOnly, archivedOnly);
  const [historyChat, setHistoryChat] = useState<MemoryChatSummary>();
  const selectedChat =
    chatList.items.find((chat) => chat._id.toString() === routeChatId) ??
      historyChat;

  const [input, setInput] = useState("");
  const [pendingMessage, setPendingMessage] = useState<
    PendingChatMessage | null
  >(
    null,
  );
  const [mobileDraftOpen, setMobileDraftOpen] = useState(false);
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [historyState, setHistoryState] = useState<
    "idle" | "loading" | "ready" | "not-found" | "error"
  >("idle");
  const [historyError, setHistoryError] = useState<string>();
  const [chatError, setChatError] = useState<ChatErrorState | null>(null);
  const [defaultChatModel, setDefaultChatModel] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string>();
  const [toolPolicy, setToolPolicy] = useState<ChatToolPolicy>(
    DEFAULT_CHAT_TOOL_POLICY,
  );
  const [toolCatalog, setToolCatalog] = useState<ChatToolCatalogEntry[]>([]);
  const [savingToolPolicy, setSavingToolPolicy] = useState(false);
  const [resolvedAliases, setResolvedAliases] = useState<
    Record<string, string>
  >({});
  const [atBottom, setAtBottom] = useState(true);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const historyVersionRef = useRef(0);
  const historyAbortRef = useRef<AbortController | null>(null);
  const localDraftNavigationRef = useRef<string | undefined>(undefined);
  const selectedModelRef = useRef("");
  const latestRequestRef = useRef<ChatMessageMetadata>({});
  const toolPolicySaveRef = useRef<Promise<void>>(Promise.resolve());
  const focusedDeepLinkRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    void Promise.all([
      callResource("llm", { action: "list" }),
      callResource("chat", { action: "listTools" }),
    ]).then(([llm, tools]) => {
      const configured = typeof llm?.chatDefaultModel === "string"
        ? llm.chatDefaultModel.trim()
        : "";
      if (configured) setDefaultChatModel(configured);
      if (llm?.resolvedAliases && typeof llm.resolvedAliases === "object") {
        setResolvedAliases(llm.resolvedAliases);
      }
      setToolCatalog(tools?.tools ?? []);
    }).catch((error) => {
      console.warn("[ChatPage] Could not load chat configuration", error);
    });
  }, []);

  useEffect(() => {
    if (!routeChatId) {
      setSelectedModel(defaultChatModel);
      setSelectedProviderId(undefined);
      setToolPolicy(DEFAULT_CHAT_TOOL_POLICY);
      setHistoryChat(undefined);
      return;
    }
    if (!selectedChat) return;
    setSelectedModel(selectedChat.model || defaultChatModel);
    setSelectedProviderId(selectedChat.providerProfileId || undefined);
    setToolPolicy({
      mode: selectedChat.toolMode ?? "auto",
      enabledTools: selectedChat.enabledTools ?? [],
    });
  }, [defaultChatModel, routeChatId, selectedChat]);

  const transport = useMemo(() =>
    new DefaultChatTransport<any>({
      api: "/api/chat",
      body: { chatId: effectiveChatId },
      fetch: async (request, init) => {
        const response = await apiClient.fetchRaw(request.toString(), init);
        const responseModel = response.headers.get("X-Mycelia-Model") ||
          selectedModelRef.current;
        const requestId = response.headers.get("X-Mycelia-Request-Id") ||
          undefined;
        const runId = response.headers.get("X-Mycelia-Run-Id") || undefined;
        latestRequestRef.current = { model: responseModel, requestId, runId };
        if (!response.ok) {
          let message = `Chat request failed with HTTP ${response.status}`;
          try {
            const payload = await response.clone().json();
            if (typeof payload?.error === "string" && payload.error.trim()) {
              message = payload.error;
            }
            latestRequestRef.current = {
              model: payload?.model || responseModel,
              requestId: payload?.requestId || requestId,
              runId: payload?.runId || runId,
            };
          } catch {
            const body = await response.clone().text();
            if (body.trim()) message = body.slice(0, 800);
          }
          throw new Error(message);
        }
        return response;
      },
    }), [effectiveChatId]);

  const chat = useChat<MemoryChatMessage>({
    id: effectiveChatId,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      setChatError({
        message: message || "Failed to send message.",
        model: latestRequestRef.current.model || selectedModelRef.current,
        requestId: latestRequestRef.current.requestId,
      });
      setPendingMessage(null);
      void chatList.refresh(false);
    },
    onFinish: ({ message, isError }) => {
      const metadata = message.metadata || latestRequestRef.current;
      if (
        !isError && message.role === "assistant" &&
        !hasRenderableAssistantOutput(message)
      ) {
        setChatError({
          message: `Model "${
            metadata.model || selectedModelRef.current
          }" returned no text or tool result.`,
          model: metadata.model || selectedModelRef.current,
          requestId: metadata.requestId,
        });
      }
      setPendingMessage(null);
      void chatList.refresh(false);
      if (document.visibilityState === "visible") {
        void callResource("chat", {
          action: "markRead",
          chatId: effectiveChatId,
        });
      }
    },
  });

  const loadHistory = useCallback(async () => {
    historyAbortRef.current?.abort();
    const version = ++historyVersionRef.current;
    if (!routeChatId) {
      chat.setMessages([]);
      setHistoryState("idle");
      return;
    }
    if (localDraftNavigationRef.current === routeChatId) {
      localDraftNavigationRef.current = undefined;
      setHistoryState("ready");
      return;
    }
    const controller = new AbortController();
    historyAbortRef.current = controller;
    setHistoryState("loading");
    setHistoryError(undefined);
    setChatError(null);
    try {
      const result = await callResource(
        "chat",
        { action: "getMessages", chatId: routeChatId },
        { signal: controller.signal },
      );
      if (
        version !== historyVersionRef.current || controller.signal.aborted
      ) return;
      if (!result.found) {
        chat.setMessages([]);
        setHistoryChat(undefined);
        setHistoryState("not-found");
        return;
      }
      chat.setMessages((result.messages ?? []).map(dbMessageToUIMessage));
      setHistoryChat(result.chat);
      setHistoryState("ready");
      if (!requestedMessageId) {
        requestAnimationFrame(() =>
          messagesEndRef.current?.scrollIntoView({ behavior: "auto" })
        );
      }
    } catch (error) {
      if (
        controller.signal.aborted || version !== historyVersionRef.current
      ) return;
      setHistoryError(
        error instanceof Error ? error.message : "Could not load chat history",
      );
      setHistoryState("error");
    }
  }, [requestedMessageId, routeChatId]);

  useEffect(() => {
    void loadHistory();
    return () => {
      historyVersionRef.current++;
      historyAbortRef.current?.abort();
    };
  }, [loadHistory]);

  useEffect(() => {
    if (routeChatId) setMobileDraftOpen(false);
  }, [routeChatId]);

  useEffect(() => {
    if (
      pendingMessage &&
      chat.messages.some((message) =>
        message.role === "user" && message.id === pendingMessage.id
      )
    ) {
      setPendingMessage(null);
    }
  }, [chat.messages, pendingMessage]);

  useEffect(() => {
    if (!routeChatId || !linkedMessageId || historyState !== "ready") return;
    if (!chat.messages.some((message) => message.id === linkedMessageId)) {
      return;
    }
    const focusKey = `${routeChatId}:${linkedMessageId}`;
    if (focusedDeepLinkRef.current === focusKey) return;

    setAtBottom(false);
    const frame = requestAnimationFrame(() => {
      if (focusDeepLinkedMessage("chat", linkedMessageId)) {
        focusedDeepLinkRef.current = focusKey;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [chat.messages, historyState, linkedMessageId, routeChatId]);

  useEffect(() => {
    if (!atBottom) return;
    if (requestedMessageId && historyState === "ready") return;
    const reducedMotion = globalThis.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    messagesEndRef.current?.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [
    atBottom,
    chat.messages,
    chat.status,
    historyState,
    requestedMessageId,
    pendingMessage,
  ]);

  useEffect(() => {
    if (
      routeChatId && selectedChat?.unread &&
      document.visibilityState === "visible"
    ) {
      void callResource("chat", { action: "markRead", chatId: routeChatId });
      chatList.update(routeChatId, { unread: false, lastReadAt: new Date() });
    }
  }, [routeChatId, selectedChat?.unread]);

  const handleSubmit = async (
    value: { text?: string },
    _event: React.FormEvent<HTMLFormElement>,
  ) => {
    const text = value.text?.trim();
    if (
      !text || chat.status === "submitted" || chat.status === "streaming"
    ) return;
    await toolPolicySaveRef.current;
    const messageId = new ObjectId().toString();
    setInput("");
    setPendingMessage({ id: messageId, text });
    setChatError(null);
    const runId = crypto.randomUUID();
    try {
      if (!routeChatId) {
        setCreatingDraft(true);
        const result = await callResource("chat", {
          action: "createDraft",
          chatId: effectiveChatId,
          initialText: text,
          preferences: {
            ...(selectedModel ? { model: selectedModel } : {}),
            providerProfileId: selectedProviderId ?? null,
            toolPolicy,
          },
        });
        if (result?.chat) {
          chatList.setItems((current) => [
            result.chat,
            ...current.filter((item) =>
              item._id.toString() !== effectiveChatId
            ),
          ]);
        }
        localDraftNavigationRef.current = effectiveChatId;
        navigate(`/chat/${effectiveChatId}`, { replace: true });
      }
      await chat.sendMessage(
        createUserUIMessage<ChatMessageMetadata>(messageId, text),
        {
          body: {
            chatId: effectiveChatId,
            runId,
            ...(selectedModel ? { model: selectedModel } : {}),
            providerProfileId: selectedProviderId ?? null,
            toolPolicy,
          },
        },
      );
    } catch (error) {
      setChatError({
        message: error instanceof Error
          ? error.message
          : "Could not send message",
        model: selectedModel,
      });
      setPendingMessage(null);
    } finally {
      setCreatingDraft(false);
    }
  };

  const handleNewChat = () => {
    resetDraft();
    navigate("/chat");
    setArchivedOnly(false);
    setFavoritesOnly(false);
    setMobileDraftOpen(true);
    setHistoryChat(undefined);
    setSelectedModel(defaultChatModel);
    setSelectedProviderId(undefined);
    setToolPolicy(DEFAULT_CHAT_TOOL_POLICY);
    setPendingMessage(null);
    setChatError(null);
  };

  const handleRename = async (chatId: string, title: string) => {
    const previous = chatList.items.find((chat) =>
      chat._id.toString() === chatId
    );
    chatList.update(chatId, { title, name: title, titleSource: "user" });
    if (historyChat?._id.toString() === chatId) {
      setHistoryChat({
        ...historyChat,
        title,
        name: title,
        titleSource: "user",
      });
    }
    try {
      await callResource("chat", { action: "rename", chatId, title });
    } catch (error) {
      if (previous) chatList.update(chatId, previous);
      toast.error("Could not rename chat", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleFavorite = async (chatId: string, favorite: boolean) => {
    const previous = chatList.items.find((chat) =>
      chat._id.toString() === chatId
    );
    const favoritedAt = favorite ? new Date() : undefined;
    chatList.update(chatId, { favoritedAt });
    if (historyChat?._id.toString() === chatId) {
      setHistoryChat({ ...historyChat, favoritedAt });
    }
    try {
      await callResource("chat", {
        action: "setFavorite",
        chatId,
        favorite,
      });
      if (favoritesOnly && !favorite) await chatList.refresh(false);
    } catch (error) {
      if (previous) chatList.update(chatId, previous);
      toast.error("Could not update favorite", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleArchive = async (chatId: string, archived: boolean) => {
    const previous = chatList.items.find((chat) =>
      chat._id.toString() === chatId
    );
    const archivedAt = archived ? new Date() : undefined;
    chatList.setItems((current) =>
      current.filter((chat) => chat._id.toString() !== chatId)
    );
    if (historyChat?._id.toString() === chatId) {
      setHistoryChat({ ...historyChat, archivedAt });
    }
    try {
      await callResource("chat", {
        action: "setArchived",
        chatId,
        archived,
      });
      if (routeChatId === chatId) {
        if (archived) {
          setHistoryChat(undefined);
          setMobileDraftOpen(false);
          navigate("/chat");
        } else {
          setArchivedOnly(false);
        }
      }
      toast.success(archived ? "Chat archived" : "Chat restored");
    } catch (error) {
      if (previous) {
        chatList.setItems((current) => [
          previous,
          ...current.filter((chat) => chat._id.toString() !== chatId),
        ]);
      }
      if (historyChat?._id.toString() === chatId) {
        setHistoryChat(historyChat);
      }
      toast.error(
        archived ? "Could not archive chat" : "Could not restore chat",
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
    }
  };

  const handleModelChange = async (
    model: string,
    providerProfileId?: string,
  ) => {
    const next = model.trim();
    if (!next) return;
    const previous = {
      model: selectedModel,
      providerProfileId: selectedProviderId,
    };
    setSelectedModel(next);
    setSelectedProviderId(providerProfileId);
    if (!routeChatId) return;
    chatList.update(routeChatId, { model: next, providerProfileId });
    try {
      await callResource("chat", {
        action: "setPreferences",
        chatId: routeChatId,
        preferences: {
          model: next,
          providerProfileId: providerProfileId ?? null,
        },
      });
    } catch (error) {
      setSelectedModel(previous.model);
      setSelectedProviderId(previous.providerProfileId);
      chatList.update(routeChatId, previous);
      toast.error("Could not save model selection", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleToolPolicyChange = async (policy: ChatToolPolicy) => {
    const previous = toolPolicy;
    setToolPolicy(policy);
    if (!routeChatId) return;
    chatList.update(routeChatId, {
      toolMode: policy.mode,
      enabledTools: policy.enabledTools,
    });
    setSavingToolPolicy(true);
    const save = (async () => {
      try {
        await callResource("chat", {
          action: "setPreferences",
          chatId: routeChatId,
          preferences: { toolPolicy: policy },
        });
      } catch (error) {
        setToolPolicy(previous);
        chatList.update(routeChatId, {
          toolMode: previous.mode,
          enabledTools: previous.enabledTools,
        });
        toast.error("Could not save tool selection", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    toolPolicySaveRef.current = save;
    await save;
    if (toolPolicySaveRef.current === save) setSavingToolPolicy(false);
  };

  const toggleMessagePin = async (message: MemoryChatMessage) => {
    if (!routeChatId || !isValidObjectId(message.id)) return;
    const wasPinned = Boolean(message.metadata?.pinnedAt);
    const pinnedAt = wasPinned ? undefined : new Date();
    const countDelta = wasPinned ? -1 : 1;
    chat.setMessages((current) =>
      current.map((item) =>
        item.id === message.id
          ? { ...item, metadata: { ...item.metadata, pinnedAt } }
          : item
      )
    );
    chatList.update(routeChatId, (summary) => ({
      ...summary,
      pinnedMessageCount: Math.max(
        0,
        summary.pinnedMessageCount + countDelta,
      ),
    }));
    if (historyChat?._id.toString() === routeChatId) {
      setHistoryChat({
        ...historyChat,
        pinnedMessageCount: Math.max(
          0,
          historyChat.pinnedMessageCount + countDelta,
        ),
      });
    }
    try {
      await callResource("chat", {
        action: "setMessagePinned",
        chatId: routeChatId,
        messageId: message.id,
        pinned: !wasPinned,
      });
    } catch (error) {
      chat.setMessages((current) =>
        current.map((item) =>
          item.id === message.id
            ? {
              ...item,
              metadata: {
                ...item.metadata,
                pinnedAt: message.metadata?.pinnedAt,
              },
            }
            : item
        )
      );
      chatList.update(routeChatId, (summary) => ({
        ...summary,
        pinnedMessageCount: Math.max(
          0,
          summary.pinnedMessageCount - countDelta,
        ),
      }));
      if (historyChat?._id.toString() === routeChatId) {
        setHistoryChat(historyChat);
      }
      toast.error("Could not update pin", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const copyMessage = async (message: MemoryChatMessage) => {
    const text = messageText(message);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Message copied");
    } catch (error) {
      toast.error("Could not copy message", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const retry = () => {
    chat.clearError();
    setChatError(null);
    void chat.regenerate({
      body: { chatId: effectiveChatId, runId: crypto.randomUUID() },
    });
  };

  const latestAssistant = [...chat.messages].reverse().find((message) =>
    message.role === "assistant"
  );
  const needsApproval = messageNeedsApproval(latestAssistant);
  const persistedRunActive = isChatRunActive(selectedChat?.lastRun?.state);
  const status = chatStatusLabel(
    chat.status,
    selectedChat?.lastRun,
    needsApproval,
  );
  const pinnedMessages = chat.messages.filter((message) =>
    message.metadata?.pinnedAt
  );
  const linkedMessageUnavailable = requestedMessageId !== null &&
    historyState === "ready" &&
    (!linkedMessageId ||
      !chat.messages.some((message) => message.id === linkedMessageId));
  const clearMessageDeepLink = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("messageId");
    setSearchParams(next, { replace: true });
  };
  const controlsDisabled = creatingDraft || savingToolPolicy ||
    chat.status === "submitted" || chat.status === "streaming" ||
    persistedRunActive || needsApproval ||
    Boolean(selectedChat?.archivedAt);
  const resolvedModel = resolvedAliases[selectedModel] || selectedModel ||
    "Configured chat default";
  const title = selectedChat?.title || selectedChat?.name || "New chat";

  const sidebar = (
    <ChatSidebar
      chats={chatList.items}
      selectedChatId={routeChatId}
      loading={chatList.loading}
      loadingMore={chatList.loadingMore}
      hasMore={chatList.hasMore}
      error={chatList.error}
      query={query}
      favoritesOnly={favoritesOnly}
      archivedOnly={archivedOnly}
      onQueryChange={setQuery}
      onFavoritesOnlyChange={(value) => {
        setFavoritesOnly(value);
        if (value) setArchivedOnly(false);
      }}
      onArchivedOnlyChange={(value) => {
        setArchivedOnly(value);
        if (value) setFavoritesOnly(false);
      }}
      onNewChat={handleNewChat}
      onRetry={() => void chatList.refresh(true)}
      onLoadMore={() => void chatList.loadMore()}
      onRename={handleRename}
      onFavorite={handleFavorite}
      onArchive={handleArchive}
    />
  );

  const thread = (
    <div className="flex h-full min-w-0 flex-col">
      <ChatThreadHeader
        chat={selectedChat}
        title={title}
        status={status}
        selectedModel={selectedModel}
        selectedProviderId={selectedProviderId}
        resolvedModel={resolvedModel}
        toolPolicy={toolPolicy}
        toolCatalog={toolCatalog}
        controlsDisabled={controlsDisabled}
        onBack={() => {
          setMobileDraftOpen(false);
          navigate("/chat");
        }}
        onRename={(nextTitle) =>
          routeChatId
            ? handleRename(routeChatId, nextTitle)
            : Promise.resolve()}
        onFavorite={(favorite) =>
          routeChatId
            ? handleFavorite(routeChatId, favorite)
            : Promise.resolve()}
        onArchive={(archived) =>
          routeChatId
            ? handleArchive(routeChatId, archived)
            : Promise.resolve()}
        onModelChange={handleModelChange}
        onToolPolicyChange={handleToolPolicyChange}
      />
      <ChatPinnedNavigation
        messages={pinnedMessages}
        onJumpToMessage={(messageId) => {
          const reducedMotion = globalThis.matchMedia(
            "(prefers-reduced-motion: reduce)",
          ).matches;
          document.getElementById(messageElementId("chat", messageId))
            ?.scrollIntoView({
              behavior: reducedMotion ? "auto" : "smooth",
              block: "center",
            });
        }}
      />
      <div
        role="log"
        aria-live="polite"
        aria-busy={chat.status === "submitted" || chat.status === "streaming"}
        onScroll={(event) => setAtBottom(isNearBottom(event.currentTarget))}
        className="relative flex-1 overflow-y-auto p-3 sm:p-4"
      >
        <ChatActivity
          messages={chat.messages}
          sdkStatus={chat.status}
          runState={selectedChat?.lastRun?.state}
          error={chatError?.message}
        />
        {historyState === "loading"
          ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader /> Loading conversation…
            </div>
          )
          : historyState === "not-found"
          ? (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <AlertCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                <h2 className="font-medium">Chat not found</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  It may have been removed or belongs to another account.
                </p>
                <Button
                  className="mt-4"
                  variant="outline"
                  onClick={() => navigate("/chat")}
                >
                  Back to chats
                </Button>
              </div>
            </div>
          )
          : historyState === "error"
          ? (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <AlertCircle className="mx-auto mb-3 h-8 w-8 text-destructive" />
                <h2 className="font-medium">Could not load chat</h2>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  {historyError}
                </p>
                <Button
                  className="mt-4"
                  variant="outline"
                  onClick={() => void loadHistory()}
                >
                  <RefreshCw className="mr-2 h-4 w-4" /> Retry
                </Button>
              </div>
            </div>
          )
          : linkedMessageUnavailable
          ? (
            <div className="flex h-full items-center justify-center text-center">
              <div role="alert">
                <AlertCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                <h2 className="font-medium">Linked message unavailable</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  It was removed or does not belong to this conversation.
                </p>
                <Button
                  className="mt-4"
                  variant="outline"
                  onClick={clearMessageDeepLink}
                >
                  Open conversation
                </Button>
              </div>
            </div>
          )
          : chat.messages.length === 0 && !pendingMessage &&
              chat.status === "ready"
          ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <div className="text-center">
                <MessageSquare className="mx-auto mb-4 h-12 w-12 opacity-50" />
                <p>Start a new conversation</p>
                <p className="mt-1 text-xs">
                  Choose a model and tools, then send a message.
                </p>
              </div>
            </div>
          )
          : (
            <>
              {chat.messages.map((message) => (
                <div
                  key={message.id}
                  id={messageElementId("chat", message.id)}
                  tabIndex={linkedMessageId === message.id ? -1 : undefined}
                  aria-current={linkedMessageId === message.id
                    ? "location"
                    : undefined}
                  className={cn(
                    "group/message relative scroll-mt-28",
                    linkedMessageId === message.id &&
                      "rounded-lg bg-primary/5 ring-2 ring-primary/60 ring-offset-2 ring-offset-background",
                  )}
                >
                  <div className="absolute right-1 top-1 z-10 flex rounded-md border bg-background/90 opacity-0 shadow-sm transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => void toggleMessagePin(message)}
                      disabled={!routeChatId || !isValidObjectId(message.id)}
                      aria-label={message.metadata?.pinnedAt
                        ? "Unpin message"
                        : "Pin message"}
                      aria-pressed={Boolean(message.metadata?.pinnedAt)}
                    >
                      <Pin
                        className={cn(
                          "h-3.5 w-3.5",
                          message.metadata?.pinnedAt &&
                            "fill-primary/20 text-primary",
                        )}
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => void copyMessage(message)}
                      disabled={!messageText(message)}
                      aria-label="Copy message"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <ChatMessageContent
                    message={message}
                    chatId={effectiveChatId}
                    addToolApprovalResponse={chat.addToolApprovalResponse}
                  />
                </div>
              ))}
              {pendingMessage && !chat.messages.some((message) =>
                message.role === "user" &&
                message.id === pendingMessage.id
              ) && (
                <div className="flex w-full justify-end py-2">
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-4 py-2 text-primary-foreground sm:max-w-[75%]">
                    <p className="whitespace-pre-wrap text-sm">
                      {pendingMessage.text}
                    </p>
                  </div>
                </div>
              )}
              {chatError && (
                <div className="my-3 flex gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-red-700 dark:text-red-400">
                      Message failed
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {chatError.message}
                    </p>
                    {(chatError.model || chatError.requestId) && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        {chatError.model && (
                          <div>
                            Model: <code>{chatError.model}</code>
                          </div>
                        )}
                        {chatError.requestId && (
                          <div>
                            Request:{"  "}
                            <code className="break-all">
                              {chatError.requestId}
                            </code>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" variant="outline" onClick={retry}>
                        <RefreshCw className="mr-1 h-4 w-4" /> Retry
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          chat.clearError();
                          setChatError(null);
                        }}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        {!atBottom && chat.messages.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            className="sticky bottom-2 left-1/2 z-20 -translate-x-1/2 rounded-full shadow"
            onClick={() => {
              const reducedMotion = globalThis.matchMedia(
                "(prefers-reduced-motion: reduce)",
              ).matches;
              messagesEndRef.current?.scrollIntoView({
                behavior: reducedMotion ? "auto" : "smooth",
              });
              setAtBottom(true);
            }}
          >
            <ArrowDown className="mr-1 h-4 w-4" /> Latest
          </Button>
        )}
      </div>
      <div className="border-t p-3 sm:p-4">
        <PromptInput
          onSubmit={handleSubmit}
          className="rounded-lg border bg-background shadow-sm"
        >
          <PromptInputTextarea
            ref={textareaRef}
            placeholder={needsApproval
              ? "Approve or deny the pending tool first"
              : savingToolPolicy
              ? "Saving tool selection…"
              : persistedRunActive
              ? "Wait for the active response to finish"
              : selectedChat?.archivedAt
              ? "Restore this chat to continue"
              : "Type a message…"}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={controlsDisabled}
          />
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputSpeechButton textareaRef={textareaRef} />
            </PromptInputTools>
            <div className="flex items-center gap-2">
              {(chat.status === "submitted" ||
                chat.status === "streaming") && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void chat.stop()}
                >
                  <Square className="mr-1 h-3.5 w-3.5 fill-current" /> Stop
                </Button>
              )}
              <PromptInputSubmit
                disabled={!input.trim() || controlsDisabled}
              />
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );

  return (
    <div className="h-[calc(100vh-7.5rem)] min-h-[520px] w-full overflow-hidden rounded-lg border bg-background shadow-sm">
      {isMobile
        ? (routeChatId || mobileDraftOpen ? thread : sidebar)
        : (
          <ResizablePanelGroup
            direction="horizontal"
            autoSaveId="mycelia-ai-chat-layout"
          >
            <ResizablePanel defaultSize={30} minSize={20} maxSize={45}>
              {sidebar}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={70}>{thread}</ResizablePanel>
          </ResizablePanelGroup>
        )}
    </div>
  );
}
