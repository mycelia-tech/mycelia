import { usePlatform } from "../core/useMessageRenderer.ts";
import type { Chat } from "@myceliasdk/messengers.ts";
import { cn } from "@/lib/utils";
import { formatRelativeTime, useFormattedTime } from "@/lib/formatTime";

interface ChatListItemProps {
  chat: Chat;
  isSelected: boolean;
  onClick: () => void;
}

export function ChatListItem({ chat, isSelected, onClick }: ChatListItemProps) {
  const platform = usePlatform(chat.platform);
  const lastDate = chat.lastMessageDate ? new Date(chat.lastMessageDate) : null;
  const formattedDate = useFormattedTime(new Date(chat.lastMessageDate ?? chat.createdAt));

  // If the platform has a custom preview component, use it
  if (platform?.ChatPreviewComponent) {
    return (
      <platform.ChatPreviewComponent 
        chat={chat} 
        isSelected={isSelected} 
        onClick={onClick} 
      />
    );
  }

  const Icon = platform?.icon;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isSelected ? "page" : undefined}
      className={cn(
        "w-full border-b border-l-2 border-l-transparent px-4 py-2.5 text-left hover:bg-muted/60 focus-visible:outline-offset-[-3px]",
        isSelected && "border-l-primary bg-accent",
      )}
    >
      <span className="block truncate font-semibold" title={chat.name}>
        {chat.name || "Unknown Chat"}
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {chat.platform && (
          <span className="inline-flex items-center gap-1 capitalize">
            {Icon && <Icon className="size-3.5" />}
            {platform?.name || chat.platform}
          </span>
        )}
        {lastDate && (
          <span className="ml-auto" title={formattedDate}>
            {formatRelativeTime(lastDate)}
          </span>
        )}
      </span>
    </button>
  );
}
