import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare, ChevronRight, Clock, Loader2, Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useMongoChanges } from "@/hooks/useMongoChanges";

interface TimeRange {
  start: string;
  end: string;
}

interface ConversationObject {
  _id: string;
  name: string;
  summary?: string;
  icon?: { text?: string };
  agreed_upon_something?: boolean;
  timeRanges?: TimeRange[];
  aliases?: string[];
  createdAt?: string;
  updatedAt?: string;
}

function formatTimeRange(timeRanges?: TimeRange[]): string {
  if (!timeRanges || timeRanges.length === 0) return "";
  
  const firstRange = timeRanges[0];
  const start = new Date(firstRange.start);
  const end = new Date(firstRange.end);
  
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: start.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
  
  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  
  const dateStr = dateFormatter.format(start);
  const startTime = timeFormatter.format(start);
  const endTime = timeFormatter.format(end);
  
  return `${dateStr} · ${startTime}–${endTime}`;
}

function formatDuration(timeRanges?: TimeRange[]): string {
  if (!timeRanges || timeRanges.length === 0) return "";
  
  const firstRange = timeRanges[0];
  const start = new Date(firstRange.start).getTime();
  const end = new Date(firstRange.end).getTime();
  const durationMs = end - start;
  
  const minutes = Math.floor(durationMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function ConversationCard({ conversation }: { conversation: ConversationObject }) {
  const emoji = conversation.icon?.text;
  const timeInfo = formatTimeRange(conversation.timeRanges);
  const duration = formatDuration(conversation.timeRanges);
  
  return (
    <Link
      to={`/objects/${conversation._id}`}
      className={cn(
        "group block min-w-0 px-3 py-3 transition-colors sm:px-4",
        "hover:bg-muted/55 focus-visible:relative focus-visible:outline focus-visible:outline-ring"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 size-9 rounded-lg bg-primary/10 flex items-center justify-center text-xl">
          {emoji || <MessagesSquare className="w-5 h-5 text-primary" />}
        </div>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3 className="line-clamp-2 break-words text-base font-semibold leading-snug group-hover:text-primary transition-colors">
              {conversation.name}
            </h3>
            <ChevronRight className="w-4 h-4 text-muted-foreground/50 group-hover:text-primary flex-shrink-0 mt-1" />
          </div>
          
          {conversation.summary && (
            <p className="mt-1 line-clamp-2 max-w-[85ch] break-words text-sm leading-relaxed text-muted-foreground">
              {conversation.summary}
            </p>
          )}
          
          {timeInfo && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
              <Clock className="w-3 h-3" />
              <span>{timeInfo}</span>
              {duration && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span>{duration}</span>
                </>
              )}
            </div>
          )}
          
          {conversation.aliases && conversation.aliases.length > 0 && (
            <div className="flex items-center gap-1 mt-2 flex-wrap">
              <Tag className="w-3 h-3 text-muted-foreground" />
              {conversation.aliases.slice(0, 3).map((alias, idx) => (
                <Badge key={idx} variant="secondary" className="text-xs py-0">
                  {alias}
                </Badge>
              ))}
              {conversation.aliases.length > 3 && (
                <span className="text-xs text-muted-foreground">+{conversation.aliases.length - 3}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

export default function ConversationsPage() {
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const queryClient = useQueryClient();
  
  const { data, isLoading, error } = useQuery({
    queryKey: ["conversations", page],
    queryFn: async () => {
      const conversations = await api.callResource("mongo", {
        action: "find",
        collection: "objects",
        query: { isConversation: true },
        options: {
          sort: { "timeRanges.0.start": -1 },
          skip: page * pageSize,
          limit: pageSize + 1,
        },
      }) as ConversationObject[];
      
      const hasMore = conversations.length > pageSize;
      return {
        conversations: conversations.slice(0, pageSize),
        hasMore,
      };
    },
  });
  
  const { data: totalCount } = useQuery({
    queryKey: ["conversations-count"],
    queryFn: async () => {
      const result = await api.callResource("mongo", {
        action: "count",
        collection: "objects",
        query: { isConversation: true },
      });
      return typeof result === "number" ? result : result?.count ?? 0;
    },
  });

  useMongoChanges("mongo:objects", (changes) => {
    const relevant = ["isConversation", "name", "summary", "timeRanges", "icon", "aliases"];
    if (!changes.some(change => change.collection === "objects" &&
      (change.operationType !== "update" || !change.changedFields?.length || change.changedFields.some(field => relevant.some(root => field === root || field.startsWith(root + ".")))))) return;
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    void queryClient.invalidateQueries({ queryKey: ["conversations-count"] });
  });

  if (isLoading && !data) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <MessagesSquare className="size-6 text-primary" />
            Conversations
          </h1>
          <p className="text-muted-foreground">
            Your extracted conversation segments in reverse chronological order
          </p>
        </div>
        
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }
  
  if (error) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <MessagesSquare className="size-6 text-primary" />
            Conversations
          </h1>
        </div>
        
        <div className="border rounded-lg p-8 text-center">
          <p className="text-red-500">
            Error: {error instanceof Error ? error.message : "Failed to load conversations"}
          </p>
        </div>
      </div>
    );
  }
  
  const conversations = data?.conversations ?? [];
  const hasMore = data?.hasMore ?? false;
  
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <MessagesSquare className="size-6 text-primary" />
          Conversations
        </h1>
        <p className="text-muted-foreground">
          {totalCount !== undefined
            ? `${totalCount} conversation${totalCount !== 1 ? "s" : ""} extracted from your recordings`
            : "Your extracted conversation segments in reverse chronological order"}
        </p>
      </div>
      
      {conversations.length === 0 ? (
        <div className="border rounded-lg p-8 text-center">
          <MessagesSquare className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
          <p className="text-muted-foreground">
            No conversations found. Conversations are automatically extracted from your transcripts.
          </p>
        </div>
      ) : (
        <>
          <div className="divide-y overflow-hidden rounded-lg border bg-card">
            {conversations.map((conversation) => (
              <ConversationCard key={conversation._id} conversation={conversation} />
            ))}
          </div>
          
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className={cn(
                "px-4 py-2 text-sm font-medium rounded-md transition-colors",
                page === 0
                  ? "text-muted-foreground/50 cursor-not-allowed"
                  : "text-primary hover:bg-primary/10"
              )}
            >
              Previous
            </button>
            
            <span className="text-sm text-muted-foreground">
              Page {page + 1}
              {totalCount !== undefined && ` of ${Math.ceil(totalCount / pageSize)}`}
            </span>
            
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasMore}
              className={cn(
                "px-4 py-2 text-sm font-medium rounded-md transition-colors",
                !hasMore
                  ? "text-muted-foreground/50 cursor-not-allowed"
                  : "text-primary hover:bg-primary/10"
              )}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
