import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, List, Pin } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { MemoryChatMessage } from "@/lib/chat";
import { messageText } from "@/lib/chat";

export function ChatPinnedNavigation({
  messages,
  onJumpToMessage,
}: {
  messages: MemoryChatMessage[];
  onJumpToMessage: (messageId: string) => void;
}) {
  const [activeId, setActiveId] = useState(messages[0]?.id);

  useEffect(() => {
    if (!messages.some((message) => message.id === activeId)) {
      setActiveId(messages[0]?.id);
    }
  }, [activeId, messages]);

  if (messages.length === 0) return null;

  const activeIndex = Math.max(
    0,
    messages.findIndex((message) => message.id === activeId),
  );
  const activeMessage = messages[activeIndex];
  const excerpt = messageText(activeMessage) || "Tool activity";

  const jump = (index: number) => {
    const normalized = (index + messages.length) % messages.length;
    const message = messages[normalized];
    setActiveId(message.id);
    onJumpToMessage(message.id);
  };

  return (
    <nav
      aria-label="Pinned message navigation"
      className="flex min-w-0 items-center gap-1 border-b bg-amber-500/5 px-3 py-1.5 sm:px-4"
    >
      <Pin className="h-3.5 w-3.5 shrink-0 text-amber-600" />
      <span className="shrink-0 text-xs font-medium text-muted-foreground">
        {activeIndex + 1}/{messages.length}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        onClick={() => jump(activeIndex - 1)}
        disabled={messages.length < 2}
        aria-label="Previous pinned message"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>
      <button
        type="button"
        onClick={() => jump(activeIndex)}
        className="min-w-0 flex-1 truncate rounded px-1 text-left text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={excerpt}
      >
        {excerpt}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        onClick={() => jump(activeIndex + 1)}
        disabled={messages.length < 2}
        aria-label="Next pinned message"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label={`Show all ${messages.length} pinned messages`}
          >
            <List className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[min(380px,calc(100vw-2rem))]"
        >
          <div className="mb-2 font-medium">Pinned messages</div>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {messages.map((message, index) => (
              <button
                key={message.id}
                type="button"
                onClick={() => jump(index)}
                aria-current={index === activeIndex ? "true" : undefined}
                className="w-full rounded-md p-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-muted"
              >
                <span className="line-clamp-2">
                  {messageText(message) || "Tool activity"}
                </span>
                <span className="text-xs capitalize text-muted-foreground">
                  {message.role}
                </span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </nav>
  );
}
