import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Search,
  Star,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatRelativeTime, useFormattedTime } from "@/lib/formatTime";
import type { MemoryChatSummary } from "@/lib/chat";

function ChatListItem({
  chat,
  selected,
  onRename,
  onFavorite,
  onArchive,
}: {
  chat: MemoryChatSummary;
  selected: boolean;
  onRename: (chatId: string, title: string) => Promise<void>;
  onFavorite: (chatId: string, favorite: boolean) => Promise<void>;
  onArchive: (chatId: string, archived: boolean) => Promise<void>;
}) {
  const chatId = chat._id.toString();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chat.title || chat.name || "New Chat");
  const inputRef = useRef<HTMLInputElement>(null);
  const displayTitle = chat.title || chat.name || "New Chat";
  const date = chat.lastMessageDate
    ? new Date(chat.lastMessageDate)
    : new Date(chat.createdAt);
  const time = useFormattedTime(date);
  const model = chat.lastResponseModel || chat.model || "Default model";

  useEffect(() => setTitle(displayTitle), [displayTitle]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const save = async () => {
    const next = title.trim();
    if (next && next !== displayTitle) await onRename(chatId, next);
    else setTitle(displayTitle);
    setEditing(false);
  };

  const runActive = chat.lastRun?.state &&
    ["submitted", "streaming", "needs_approval"].includes(chat.lastRun.state);
  const content = (
    <div className="min-w-0 flex-1">
      {editing
        ? (
          <Input
            ref={inputRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              }
              if (event.key === "Escape") {
                setTitle(displayTitle);
                setEditing(false);
              }
            }}
            aria-label="Chat title"
            className="h-8"
          />
        )
        : (
          <div className="flex min-w-0 items-center gap-1.5">
            {chat.unread && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                title="Unread"
              />
            )}
            {chat.favoritedAt && (
              <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-500" />
            )}
            <span className="truncate text-sm font-medium">
              {displayTitle}
            </span>
            {chat.archivedAt && (
              <Archive className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            {chat.lastRun?.state &&
              !["completed", "cancelled"].includes(chat.lastRun.state) && (
              <Badge
                variant="outline"
                className="shrink-0 px-1.5 text-xs capitalize"
              >
                {chat.lastRun.state.replace("_", " ")}
              </Badge>
            )}
          </div>
        )}
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        <span className="shrink-0">{chat.messageCount} messages</span>
        <span aria-hidden="true">·</span>
        <span
          className="flex shrink-0 items-center gap-0.5"
          aria-label={`${chat.pinnedMessageCount} pinned messages`}
        >
          <Pin className="h-2.5 w-2.5" /> {chat.pinnedMessageCount}
        </span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 flex-1 basis-12 truncate" title={model}>
          {model}
        </span>
        <span className="ml-auto shrink-0" title={time}>
          {formatRelativeTime(date)}
        </span>
      </div>
    </div>
  );

  return (
    <div
      className={cn(
        "group relative border-b border-l-2 border-l-transparent px-3 py-2.5 transition-colors hover:bg-muted/50",
        selected && "border-l-primary bg-accent",
      )}
    >
      <div className="flex items-center gap-1">
        {editing
          ? (
            <div className="flex min-w-0 flex-1 items-center">
              {content}
            </div>
          )
          : (
            <Link
              to={`/chat/${chatId}`}
              aria-current={selected ? "page" : undefined}
              className="flex min-w-0 flex-1 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={displayTitle}
            >
              {content}
            </Link>
          )}
        {!editing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100"
                aria-label={`Actions for ${displayTitle}`}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditing(true)}>
                <Pencil className="mr-2 h-3.5 w-3.5" /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void onFavorite(chatId, !chat.favoritedAt)}
              >
                <Star className="mr-2 h-3.5 w-3.5" />
                {chat.favoritedAt ? "Remove favorite" : "Add favorite"}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!chat.archivedAt && Boolean(runActive)}
                onClick={() => void onArchive(chatId, !chat.archivedAt)}
              >
                {chat.archivedAt
                  ? <ArchiveRestore className="mr-2 h-3.5 w-3.5" />
                  : <Archive className="mr-2 h-3.5 w-3.5" />}
                {chat.archivedAt ? "Restore chat" : "Archive chat"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

export function ChatSidebar({
  chats,
  selectedChatId,
  loading,
  loadingMore,
  hasMore,
  error,
  query,
  favoritesOnly,
  archivedOnly,
  onQueryChange,
  onFavoritesOnlyChange,
  onArchivedOnlyChange,
  onNewChat,
  onRetry,
  onLoadMore,
  onRename,
  onFavorite,
  onArchive,
}: {
  chats: MemoryChatSummary[];
  selectedChatId?: string;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error?: string;
  query: string;
  favoritesOnly: boolean;
  archivedOnly: boolean;
  onQueryChange: (query: string) => void;
  onFavoritesOnlyChange: (value: boolean) => void;
  onArchivedOnlyChange: (value: boolean) => void;
  onNewChat: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onRename: (chatId: string, title: string) => Promise<void>;
  onFavorite: (chatId: string, favorite: boolean) => Promise<void>;
  onArchive: (chatId: string, archived: boolean) => Promise<void>;
}) {
  const favorites = chats.filter((chat) => Boolean(chat.favoritedAt));
  const recent = chats.filter((chat) => !chat.favoritedAt);
  const sections = archivedOnly
    ? [{ label: "Archived", items: chats }]
    : favoritesOnly
    ? [{ label: "Favorites", items: favorites }]
    : [
      { label: "Favorites", items: favorites },
      {
        label: favorites.length > 0 ? "Recent" : "Conversations",
        items: recent,
      },
    ];

  return (
    <aside
      className="flex h-full min-w-0 flex-col"
      aria-label="AI chat conversations"
    >
      <div className="border-b bg-muted/40 p-3">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Conversations</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onNewChat}
            aria-label="New chat"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="pl-8"
            />
          </div>
          <Button
            type="button"
            variant={favoritesOnly ? "secondary" : "outline"}
            size="icon"
            onClick={() => onFavoritesOnlyChange(!favoritesOnly)}
            aria-pressed={favoritesOnly}
            aria-label={favoritesOnly
              ? "Show all chats"
              : "Show favorites only"}
          >
            <Star
              className={cn(
                "h-4 w-4",
                favoritesOnly && "fill-amber-400 text-amber-500",
              )}
            />
          </Button>
          <Button
            type="button"
            variant={archivedOnly ? "secondary" : "outline"}
            size="icon"
            onClick={() => onArchivedOnlyChange(!archivedOnly)}
            aria-pressed={archivedOnly}
            aria-label={archivedOnly
              ? "Show active chats"
              : "Show archived chats"}
          >
            {archivedOnly
              ? <ArchiveRestore className="h-4 w-4" />
              : <Archive className="h-4 w-4" />}
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1">
        {loading
          ? (
            <div className="space-y-3 p-3" aria-label="Loading chats">
              {[1, 2, 3, 4].map((item) => (
                <Skeleton key={item} className="h-20 w-full" />
              ))}
            </div>
          )
          : error
          ? (
            <div className="m-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
              <div className="flex gap-2">
                <AlertCircle className="h-4 w-4" /> Could not load chats
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{error}</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={onRetry}
              >
                Retry
              </Button>
            </div>
          )
          : chats.length === 0
          ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {archivedOnly
                ? "No archived conversations"
                : "No conversations found"}
            </div>
          )
          : (
            <div>
              {sections.map((section) =>
                section.items.length > 0 && (
                  <section key={section.label} aria-label={section.label}>
                    <div className="sticky top-0 z-10 border-b bg-background/95 px-3 py-1.5 text-xs font-semibold text-muted-foreground backdrop-blur">
                      {section.label}
                    </div>
                    {section.items.map((chat) => (
                      <ChatListItem
                        key={chat._id.toString()}
                        chat={chat}
                        selected={selectedChatId === chat._id.toString()}
                        onRename={onRename}
                        onFavorite={onFavorite}
                        onArchive={onArchive}
                      />
                    ))}
                  </section>
                )
              )}
              {hasMore && (
                <div className="p-3 text-center">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={loadingMore}
                    onClick={onLoadMore}
                  >
                    {loadingMore ? "Loading…" : "Load older chats"}
                  </Button>
                </div>
              )}
            </div>
          )}
      </ScrollArea>
    </aside>
  );
}
