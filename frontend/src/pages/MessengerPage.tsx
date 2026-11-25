import { RequestError } from "@/components/RequestError";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Info } from "lucide-react";
import * as InfiniteScrollModule from "react-infinite-scroll-component";
const InfiniteScroll = (InfiniteScrollModule as any).default ||
  InfiniteScrollModule;
import { callResource } from "@/lib/api";
import type { Chat, Message as IMessage } from "@myceliasdk/messengers.ts";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { useFormattedTime } from "@/lib/formatTime";
import { cn } from "@/lib/utils";
import {
  focusDeepLinkedMessage,
  loadMessengerMessageWindow,
  messageElementId,
  mongoDeepLinkIdReference,
  normalizeMessageDeepLinkId,
} from "@/lib/messageDeepLink";

// Messenger Module Imports
import { registry } from "@/modules/messenger/core/registry.ts";
import { defaultPlatform } from "@/modules/messenger/platforms/default.tsx";
import { telegramPlatform } from "@/modules/messenger/platforms/telegram.tsx";
import { signalPlatform } from "@/modules/messenger/platforms/signal.tsx";
import { myceliaPlatform } from "@/modules/messenger/platforms/mycelia.tsx";
import { ChatListItem } from "@/modules/messenger/components/ChatListItem.tsx";
import { MessageBubble } from "@/modules/messenger/components/MessageBubble.tsx";

// Register platforms
registry.register(defaultPlatform);
registry.register(telegramPlatform);
registry.register(signalPlatform);
registry.register(myceliaPlatform);
registry.setDefault(defaultPlatform.id);

const MESSAGES_PER_PAGE = 50;

export default function MessengerPage() {
  const { chatId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const requestedMessageId = searchParams.get("messageId");
  const linkedMessageId = normalizeMessageDeepLinkId(
    requestedMessageId,
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const focusedDeepLinkRef = useRef<string | undefined>(undefined);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [chatRefresh, setChatRefresh] = useState(0);
  const [messageRefresh, setMessageRefresh] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const currentChatRef = useRef(chatId);
  currentChatRef.current = chatId;
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<IMessage[]>([]);
  const [loadingChats, setLoadingChats] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [linkedMessageUnavailable, setLinkedMessageUnavailable] = useState(
    false,
  );
  const [hasMore, setHasMore] = useState(false);
  const [oldestMessageTimestamp, setOldestMessageTimestamp] = useState<
    Date | null
  >(null);
  const [scrollHeight, setScrollHeight] = useState<number>(500);

  // Fetch Chats
  useEffect(() => {
    let cancelled = false;
    const fetchChats = async () => {
      try {
        setLoadingChats(true);
        setChatsError(null);
        const result = await callResource("mongo", {
          action: "find",
          collection: "chats",
          query: {},
          options: {
            sort: { lastMessageDate: -1 },
          },
        });
        if (!cancelled) setChats(result);
      } catch (err) {
        if (!cancelled) {
          setChatsError(
            err instanceof Error ? err.message : "Could not load chats.",
          );
        }
      } finally {
        if (!cancelled) setLoadingChats(false);
      }
    };

    void fetchChats();
    return () => {
      cancelled = true;
    };
  }, [chatRefresh]);

  // Fetch initial messages for selected chat
  useEffect(() => {
    let cancelled = false;
    setMessagesError(null);
    setMoreError(null);
    setLoadingMore(false);
    loadingMoreRef.current = false;
    if (!chatId) {
      setMessages([]);
      setLoadingMessages(false);
      setHasMore(false);
      setOldestMessageTimestamp(null);
      setLinkedMessageUnavailable(false);
      return;
    }

    const loadInitialMessages = async () => {
      setMessages([]);
      setHasMore(true);
      setOldestMessageTimestamp(null);
      setLoadingMessages(true);
      setLinkedMessageUnavailable(false);

      try {
        if (requestedMessageId !== null) {
          if (!linkedMessageId) {
            setHasMore(false);
            setLinkedMessageUnavailable(true);
            return;
          }
          const focusedWindow = await loadMessengerMessageWindow(
            callResource,
            {
              chatId,
              messageId: linkedMessageId,
              pageSize: MESSAGES_PER_PAGE,
            },
          );
          if (cancelled) return;
          if (focusedWindow.state === "found") {
            setMessages(focusedWindow.messages);
            setOldestMessageTimestamp(focusedWindow.oldestTimestamp);
            setHasMore(focusedWindow.hasMoreOlder);
            return;
          }
          setHasMore(false);
          setLinkedMessageUnavailable(true);
          return;
        }

        const chatReference = mongoDeepLinkIdReference(chatId);
        if (!chatReference) {
          setHasMore(false);
          return;
        }
        const query: any = { chatId: chatReference };

        const result = await callResource("mongo", {
          action: "find",
          collection: "messages",
          query,
          options: {
            sort: { timestamp: -1 },
            limit: MESSAGES_PER_PAGE + 1,
          },
        });
        if (cancelled) return;

        const hasMoreMessages = result.length > MESSAGES_PER_PAGE;
        const messagesToShow = hasMoreMessages
          ? result.slice(0, MESSAGES_PER_PAGE)
          : result;

        if (messagesToShow.length > 0) {
          const last = messagesToShow[messagesToShow.length - 1];
          setMessages(messagesToShow);
          setOldestMessageTimestamp(new Date(last.timestamp));
          setHasMore(hasMoreMessages);
        } else {
          setHasMore(false);
        }
      } catch (err) {
        if (cancelled) return;
        setMessagesError(
          err instanceof Error ? err.message : "Could not load messages.",
        );
        setHasMore(false);
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    };

    void loadInitialMessages();
    return () => {
      cancelled = true;
    };
  }, [chatId, linkedMessageId, requestedMessageId, messageRefresh]);

  useEffect(() => {
    if (!chatId || !linkedMessageId || loadingMessages) return;
    if (
      !messages.some((message) => message._id.toString() === linkedMessageId)
    ) {
      return;
    }
    const focusKey = `${chatId}:${linkedMessageId}`;
    if (focusedDeepLinkRef.current === focusKey) return;

    const frame = requestAnimationFrame(() => {
      if (focusDeepLinkedMessage("messenger", linkedMessageId)) {
        focusedDeepLinkRef.current = focusKey;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [chatId, linkedMessageId, loadingMessages, messages]);

  // Calculate scroll container height dynamically
  useEffect(() => {
    const updateHeight = () => {
      if (scrollContainerRef.current) {
        const height = scrollContainerRef.current.offsetHeight;
        setScrollHeight(height);
      }
    };

    updateHeight();

    globalThis.addEventListener("resize", updateHeight);
    return () => globalThis.removeEventListener("resize", updateHeight);
  }, [chatId]);

  // Load more messages (older messages)
  const loadMoreMessages = useCallback(async () => {
    if (!chatId || loadingMoreRef.current || loadingMessages) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError(null);
    const requestedChat = chatId;
    try {
      const chatReference = mongoDeepLinkIdReference(chatId);
      if (!chatReference) {
        setHasMore(false);
        return;
      }
      const query: any = { chatId: chatReference };
      if (oldestMessageTimestamp) {
        query.timestamp = { $lt: oldestMessageTimestamp };
      }

      const result = await callResource("mongo", {
        action: "find",
        collection: "messages",
        query,
        options: {
          sort: { timestamp: -1 },
          limit: MESSAGES_PER_PAGE + 1,
        },
      });

      if (currentChatRef.current !== requestedChat) return;
      const hasMoreMessages = result.length > MESSAGES_PER_PAGE;
      const messagesToShow = hasMoreMessages
        ? result.slice(0, MESSAGES_PER_PAGE)
        : result;

      if (messagesToShow.length > 0) {
        const last = messagesToShow[messagesToShow.length - 1];
        setMessages((prev) => [...prev, ...messagesToShow]);
        setOldestMessageTimestamp(new Date(last.timestamp));
        setHasMore(hasMoreMessages);
      } else {
        setHasMore(false);
      }
    } catch (err) {
      if (currentChatRef.current === requestedChat) {
        setMoreError(
          err instanceof Error ? err.message : "Could not load older messages.",
        );
      }
    } finally {
      if (currentChatRef.current === requestedChat) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [chatId, oldestMessageTimestamp, loadingMessages]);

  const selectedChat = chats.find((c) => c._id.toString() === chatId);

  const lastMessageDate = selectedChat?.lastMessageDate
    ? new Date(selectedChat.lastMessageDate)
    : new Date();
  const createdAtDate = selectedChat
    ? new Date(selectedChat.createdAt)
    : new Date();
  const updatedAtDate = selectedChat
    ? new Date(selectedChat.updatedAt)
    : new Date();

  const lastMessageFormatted = useFormattedTime(lastMessageDate);
  const createdAtFormatted = useFormattedTime(createdAtDate);
  const updatedAtFormatted = useFormattedTime(updatedAtDate);

  return (
    <div className="h-[var(--workspace-panel-height,calc(100dvh-7rem))] min-h-64 w-full overflow-hidden rounded-xl border bg-card shadow-sm">
      <ResizablePanelGroup direction="horizontal">
        {/* Chat List */}
        <ResizablePanel defaultSize={30} minSize={20} maxSize={45} className={chatId ? "hidden md:block" : undefined}>
          <div className="h-full flex flex-col">
            <div className="border-b bg-muted/40 px-4 py-3">
              <h1 className="text-lg font-semibold">Chats</h1>
            </div>
            <ScrollArea className="flex-1">
              {chatsError && (
                <RequestError
                  title="Chats could not be loaded"
                  message={chatsError}
                  onRetry={() => setChatRefresh((value) => value + 1)}
                  pending={loadingChats}
                />
              )}
              {loadingChats
                ? (
                  <div className="p-4 space-y-4">
                    {[1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-16 w-full" />
                    ))}
                  </div>
                )
                : (
                  <div className="flex flex-col">
                    {chats.map((chat) => (
                      <ChatListItem
                        key={chat._id.toString()}
                        chat={chat}
                        isSelected={chatId === chat._id.toString()}
                        onClick={() =>
                          navigate(`/messaging/${chat._id.toString()}`)}
                      />
                    ))}
                    {chats.length === 0 && !chatsError && (
                      <div className="p-8 text-center text-muted-foreground">
                        No chats found
                      </div>
                    )}
                  </div>
                )}
            </ScrollArea>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle className="hidden md:flex" />

        {/* Message Thread */}
        <ResizablePanel defaultSize={70} className={chatId ? undefined : "hidden md:block"}>
          {chatId
            ? (
              <div className="h-full flex flex-col">
                <div className="flex items-center justify-between gap-2 border-b bg-card px-3 py-2.5 sm:px-4">
                  <div className="flex min-w-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0 md:hidden"
                      onClick={() => navigate("/messaging")}
                      aria-label="Back to chats"
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-semibold" title={selectedChat?.name}>
                        {selectedChat?.name || "Messages"}
                      </h2>
                      <p className="text-xs text-muted-foreground capitalize">
                        {selectedChat?.platform}
                      </p>
                    </div>
                  </div>
                  {selectedChat && (
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Chat information"
                          className="shrink-0"
                        >
                          <Info className="h-4 w-4" />
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-2xl max-h-[80vh]">
                        <DialogHeader>
                          <DialogTitle>Chat Information</DialogTitle>
                        </DialogHeader>
                        <ScrollArea className="max-h-[60vh] pr-4">
                          <div className="space-y-4">
                            <div className="space-y-2">
                              <div className="grid grid-cols-[120px_1fr] gap-2 items-start">
                                <span className="text-sm font-medium text-muted-foreground">
                                  Name:
                                </span>
                                <span className="text-sm">
                                  {selectedChat.name || "N/A"}
                                </span>
                              </div>
                              <div className="grid grid-cols-[120px_1fr] gap-2 items-start">
                                <span className="text-sm font-medium text-muted-foreground">
                                  Platform:
                                </span>
                                <span className="text-sm capitalize">
                                  {selectedChat.platform}
                                </span>
                              </div>
                              <div className="grid grid-cols-[120px_1fr] gap-2 items-start">
                                <span className="text-sm font-medium text-muted-foreground">
                                  Type:
                                </span>
                                <span className="text-sm capitalize">
                                  {selectedChat.type || "N/A"}
                                </span>
                              </div>
                              <div className="grid grid-cols-[120px_1fr] gap-2 items-start">
                                <span className="text-sm font-medium text-muted-foreground">
                                  External ID:
                                </span>
                                <span className="break-all font-mono text-sm">
                                  {String(selectedChat.externalId)}
                                </span>
                              </div>
                              <div className="grid grid-cols-[120px_1fr] gap-2 items-start">
                                <span className="text-sm font-medium text-muted-foreground">
                                  Chat ID:
                                </span>
                                <span className="break-all font-mono text-sm">
                                  {selectedChat._id.toString()}
                                </span>
                              </div>
                              {selectedChat.lastMessageDate && (
                                <div className="grid grid-cols-[120px_1fr] gap-2 items-start">
                                  <span className="text-sm font-medium text-muted-foreground">
                                    Last Message:
                                  </span>
                                  <span className="text-sm">
                                    {lastMessageFormatted}
                                  </span>
                                </div>
                              )}
                              <div className="grid grid-cols-[120px_1fr] gap-2 items-start">
                                <span className="text-sm font-medium text-muted-foreground">
                                  Created:
                                </span>
                                <span className="text-sm">
                                  {createdAtFormatted}
                                </span>
                              </div>
                              <div className="grid grid-cols-[120px_1fr] gap-2 items-start">
                                <span className="text-sm font-medium text-muted-foreground">
                                  Updated:
                                </span>
                                <span className="text-sm">
                                  {updatedAtFormatted}
                                </span>
                              </div>
                            </div>
                            {selectedChat.raw && (
                              <div className="space-y-2">
                                <h3 className="text-sm font-medium">
                                  Raw Data
                                </h3>
                                <CodeBlock
                                  code={JSON.stringify(
                                    selectedChat.raw,
                                    null,
                                    2,
                                  )}
                                  language="json"
                                  className="text-xs"
                                />
                              </div>
                            )}
                          </div>
                        </ScrollArea>
                      </DialogContent>
                    </Dialog>
                  )}
                </div>
                <div
                  ref={scrollContainerRef}
                  className="min-h-0 flex-1 overflow-hidden"
                >
                  {loadingMessages
                    ? (
                      <p
                        role="status"
                        className="p-6 text-center text-muted-foreground"
                      >
                        Loading messages…
                      </p>
                    )
                    : messagesError
                    ? (
                      <RequestError
                        title="Messages could not be loaded"
                        message={messagesError}
                        onRetry={() => setMessageRefresh((value) => value + 1)}
                      />
                    )
                    : linkedMessageUnavailable
                    ? (
                      <div className="flex h-full items-center justify-center text-center">
                        <div role="alert">
                          <Info className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                          <h2 className="font-medium">
                            Linked message unavailable
                          </h2>
                          <p className="mt-1 text-sm text-muted-foreground">
                            It was removed or does not belong to this chat.
                          </p>
                          <Button
                            className="mt-4"
                            variant="outline"
                            onClick={() => navigate(`/messaging/${chatId}`)}
                          >
                            Open latest messages
                          </Button>
                        </div>
                      </div>
                    )
                    : (
                      <>
                        {moreError && (
                          <RequestError
                            title="Older messages could not be loaded"
                            message={moreError}
                            onRetry={() => {
                              void loadMoreMessages();
                            }}
                            pending={loadingMore}
                          />
                        )}
                        {!messages.length && (
                          <p className="p-6 text-center text-muted-foreground">
                            No messages in this chat
                          </p>
                        )}
                        <InfiniteScroll
                          dataLength={messages.length}
                          next={loadMoreMessages}
                          hasMore={hasMore && !moreError}
                          loader={
                            <div className="flex justify-center py-2">
                              <div className="text-xs text-muted-foreground">
                                Loading more messages...
                              </div>
                            </div>
                          }
                          height={`${scrollHeight}px`}
                          inverse
                          style={{
                            display: "flex",
                            flexDirection: "column-reverse",
                          }}
                          className="gap-2 bg-background/60 p-3 sm:p-4"
                        >
                          {messages.map((msg) => {
                            const messageId = msg._id.toString();
                            const focused = messageId === linkedMessageId;
                            return (
                              <div
                                key={messageId}
                                id={messageElementId("messenger", messageId)}
                                tabIndex={focused ? -1 : undefined}
                                aria-current={focused ? "location" : undefined}
                                className={cn(
                                  "scroll-mt-20 rounded-lg",
                                  focused &&
                                    "bg-primary/5 ring-2 ring-primary/60 ring-offset-2 ring-offset-background",
                                )}
                              >
                                <MessageBubble message={msg} />
                              </div>
                            );
                          })}
                        </InfiniteScroll>
                      </>
                    )}
                </div>
              </div>
            )
            : (
              <div className="h-full flex items-center justify-center text-muted-foreground bg-muted/10">
                <div className="text-center">
                  <p>Select a chat to view messages</p>
                </div>
              </div>
            )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
