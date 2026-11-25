import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  Star,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModelSelector } from "@/components/ModelSelector";
import { ChatToolSelector } from "@/components/chat/ChatToolSelector";
import { cn } from "@/lib/utils";
import type { MemoryChatSummary } from "@/lib/chat";
import type {
  ChatToolCatalogEntry,
  ChatToolPolicy,
} from "@myceliasdk/messengers.ts";

export function ChatThreadHeader({
  chat,
  title,
  status,
  selectedModel,
  selectedProviderId,
  resolvedModel,
  toolPolicy,
  toolCatalog,
  toolCatalogError,
  controlsDisabled,
  onBack,
  onRename,
  onFavorite,
  onArchive,
  onCatalogLoaded,
  onModelChange,
  onToolPolicyChange,
}: {
  chat?: MemoryChatSummary;
  title: string;
  status: string;
  selectedModel: string;
  selectedProviderId?: string;
  resolvedModel: string;
  toolPolicy: ChatToolPolicy;
  toolCatalog: ChatToolCatalogEntry[];
  toolCatalogError?: string;
  controlsDisabled?: boolean;
  onBack: () => void;
  onRename: (title: string) => Promise<void>;
  onFavorite: (favorite: boolean) => Promise<void>;
  onArchive: (archived: boolean) => Promise<void>;
  onCatalogLoaded: NonNullable<
    React.ComponentProps<typeof ModelSelector>["onCatalogLoaded"]
  >;
  onModelChange: (model: string, providerProfileId?: string) => Promise<void>;
  onToolPolicyChange: (policy: ChatToolPolicy) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [nextTitle, setNextTitle] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setNextTitle(title), [title]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const saveTitle = async () => {
    const trimmed = nextTitle.trim();
    if (trimmed && trimmed !== title) await onRename(trimmed);
    else setNextTitle(title);
    setEditing(false);
  };

  return (
    <header className="border-b bg-card px-3 py-2.5 sm:px-4">
      <div className="flex min-w-0 items-start gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onBack}
          aria-label="Back to chats"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {editing
              ? (
                <div className="flex min-w-0 flex-1 gap-1">
                  <Input
                    ref={inputRef}
                    value={nextTitle}
                    onChange={(event) => setNextTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveTitle();
                      if (event.key === "Escape") {
                        setNextTitle(title);
                        setEditing(false);
                      }
                    }}
                    className="h-8"
                    aria-label="Chat title"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => void saveTitle()}
                    aria-label="Save chat title"
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setEditing(false)}
                    aria-label="Cancel rename"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              )
              : (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  disabled={!chat}
                  className="min-w-0 truncate rounded text-left text-lg font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title={`${title} — click to rename`}
                >
                  {title}
                </button>
              )}
            <Badge
              variant={status === "Error" ? "destructive" : "outline"}
              className={cn(
                "shrink-0",
                status === "Answering" && "border-blue-500/40 text-blue-600",
                status === "Needs approval" &&
                  "border-amber-500/40 text-amber-600",
              )}
              role="status"
              aria-live="polite"
            >
              {status}
            </Badge>
          </div>
          <div
            className="mt-1 truncate text-xs text-muted-foreground"
            title={resolvedModel}
          >
            Next response: {selectedModel || "configured default"}
            {selectedModel && resolvedModel !== selectedModel
              ? ` → ${resolvedModel}`
              : ""}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void onArchive(!chat?.archivedAt)}
          aria-label={chat?.archivedAt ? "Restore chat" : "Archive chat"}
          disabled={!chat || (controlsDisabled && !chat.archivedAt)}
        >
          {chat?.archivedAt
            ? <ArchiveRestore className="h-4 w-4 text-primary" />
            : <Archive className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void onFavorite(!chat?.favoritedAt)}
          aria-label={chat?.favoritedAt
            ? "Remove chat from favorites"
            : "Add chat to favorites"}
          disabled={!chat}
        >
          <Star
            className={cn(
              "h-4 w-4",
              chat?.favoritedAt && "fill-amber-400 text-amber-500",
            )}
          />
        </Button>
      </div>
      <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <ModelSelector
            value={selectedModel}
            onChange={() => {}}
            providerValue={selectedProviderId}
            onSelectWithProvider={(model, providerProfileId) =>
              void onModelChange(model, providerProfileId)}
            disabled={controlsDisabled}
            placeholder="Use configured chat default"
            className="min-w-0 max-w-full"
            prefetch
            showAvailability
            onCatalogLoaded={onCatalogLoaded}
          />
        </div>
        <ChatToolSelector
          policy={toolPolicy}
          catalog={toolCatalog}
          disabled={controlsDisabled}
          onChange={(policy) => void onToolPolicyChange(policy)}
        />
      </div>
      {toolCatalogError && (
        <p className="mt-2 text-xs text-destructive" role="status">
          Could not load chat tools. {toolCatalogError}
        </p>
      )}
    </header>
  );
}
