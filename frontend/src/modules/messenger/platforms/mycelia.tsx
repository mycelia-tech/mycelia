import type { Platform } from "../core/types.ts";
import { defaultPlatform } from "./default.tsx";
import { User } from "lucide-react";
import { Link } from "react-router-dom";
import type { ToolUIPart } from "ai";
import { splitUnparsedToolText } from "@myceliasdk/chat-tool-text.ts";
import { formatRelativeTime } from "@/lib/formatTime";
import { cn } from "@/lib/utils";
import { Response } from "@/components/ai-elements/response";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { ActionCard } from "@/components/chat/ActionCard";
import {
  formatToolName,
  parseToolOutput,
  summarizeToolCall,
  WRITE_TOOLS,
} from "@/lib/toolPresentation";

interface MyceliaMessageProps {
  message: import("@myceliasdk/messengers.ts").Message;
  children?: React.ReactNode;
}

interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output?: { type: string; value: unknown };
  error?: string;
}

interface ParsedMessageContent {
  role: "user" | "assistant";
  content: string;
  hasUnparsedCalls: boolean;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    output?: unknown;
    error?: string;
    state: ToolUIPart["state"];
  }>;
}

function parseMessageContent(raw: any): ParsedMessageContent {
  const role = raw?.role === "user" ? "user" : "assistant";
  let hasUnparsedCalls = false;
  const visibleText = (text: string) => {
    if (role === "user") return text;
    const result = splitUnparsedToolText(text);
    hasUnparsedCalls ||= result.hasUnparsedCalls;
    return result.content;
  };

  // Prefer UIMessage parts: live streaming messages and new-format persisted
  // messages carry them, including tool state and approval info.
  const uiParts = raw?.uiMessage?.parts;
  if (Array.isArray(uiParts)) {
    const textContent = uiParts
      .filter((part: any) => part?.type === "text" && part?.text)
      .map((part: any) => visibleText(part.text))
      .filter(Boolean)
      .join("\n\n");
    const toolCalls: ParsedMessageContent["toolCalls"] = uiParts
      .filter((part: any) =>
        typeof part?.type === "string" &&
        (part.type.startsWith("tool-") || part.type === "dynamic-tool")
      )
      .map((part: any) => ({
        toolCallId: part.toolCallId,
        toolName: part.type === "dynamic-tool"
          ? part.toolName
          : part.type.slice(5),
        input: part.input ?? {},
        output: part.output,
        error: part.errorText,
        state: part.state ?? "input-available",
      }));
    return { role, content: textContent, hasUnparsedCalls, toolCalls };
  }

  const content = raw?.content;
  let textContent = "";
  const toolCalls: ParsedMessageContent["toolCalls"] = [];

  if (typeof content === "string") {
    textContent = visibleText(content);
  } else if (Array.isArray(content)) {
    const textParts = content
      .filter((part: any) => part?.type === "text" && part?.text)
      .map((part: any) => visibleText(part.text))
      .filter(Boolean)
      .join("\n\n");

    textContent = textParts;

    // Extract tool calls and results
    const toolCallParts = content.filter((part: any) =>
      part?.type === "tool-call"
    ) as ToolCallPart[];
    const toolResultParts = content.filter((part: any) =>
      part?.type === "tool-result"
    ) as ToolResultPart[];

    for (const call of toolCallParts) {
      const result = toolResultParts.find((r) =>
        r.toolCallId === call.toolCallId
      );
      toolCalls.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input || {},
        output: result?.output,
        error: result?.error,
        state: result?.error
          ? "output-error"
          : result
          ? "output-available"
          : "input-available",
      });
    }
  }

  return { role, content: textContent, hasUnparsedCalls, toolCalls };
}

function ToolCallDisplay(
  { toolCall }: { toolCall: ParsedMessageContent["toolCalls"][0] },
) {
  const summary = summarizeToolCall(toolCall);
  const displayOutput = toolCall.output === undefined
    ? undefined
    : parseToolOutput(toolCall.output);
  const isFinishedWrite = WRITE_TOOLS.has(toolCall.toolName) &&
    (toolCall.state === "output-available" ||
      toolCall.state === "output-error");

  const detail = (
    <Tool className="group">
      <ToolHeader
        title={isFinishedWrite ? formatToolName(toolCall.toolName) : summary}
        type="tool-call"
        state={toolCall.state}
      />
      <ToolContent>
        <ToolInput input={toolCall.input} />
        <ToolOutput
          output={displayOutput}
          errorText={toolCall.error}
        />
      </ToolContent>
    </Tool>
  );

  // Completed writes get a prominent confirmation card with a link to the
  // affected object; the raw JSON stays available in the collapsible below.
  if (isFinishedWrite) {
    return (
      <div className="space-y-1">
        <ActionCard
          toolName={toolCall.toolName}
          input={toolCall.input}
          output={toolCall.output}
          state={toolCall.state}
        />
        {detail}
      </div>
    );
  }

  return detail;
}

function MyceliaMessageBubble({ message }: MyceliaMessageProps) {
  const formattedDate = formatRelativeTime(new Date(message.timestamp));
  const raw = message.raw;

  const { role, content, hasUnparsedCalls, toolCalls } = parseMessageContent(
    raw,
  );
  const isUser = role === "user";
  const hasToolCalls = toolCalls.length > 0;
  const hasContent = content.length > 0;
  const responseModel = typeof raw?.model === "string" ? raw.model : undefined;
  const requestId = typeof raw?.requestId === "string"
    ? raw.requestId
    : undefined;
  const responseError = typeof raw?.error?.message === "string"
    ? raw.error.message
    : undefined;

  const senderName = isUser
    ? (raw?.from || raw?.sender_name || "You")
    : "Mycelia";


  return (
    <div
      className={cn(
        "flex w-full py-2 group",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 max-w-full gap-2 sm:max-w-[min(85%,72ch)] sm:gap-3",
          isUser ? "flex-row-reverse" : "flex-row",
        )}
      >
        {/* Avatar */}
        <div
          className={cn(
            "shrink-0 w-8 h-8 rounded-full flex items-center justify-center",
            isUser
              ? "bg-primary/10 text-primary"
              : "bg-gradient-to-br from-amber-500/20 via-orange-500/20 to-red-500/20",
          )}
        >
          {isUser
            ? <User className="w-4 h-4" />
            : (
              <span className="text-base" role="img" aria-label="Mycelia">
                🍄
              </span>
            )}
        </div>

        {/* Message Content */}
        <div className="flex flex-col min-w-0 gap-1">
          {/* Header */}
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-2 gap-y-1",
              isUser ? "justify-end" : "justify-start",
            )}
          >
            {message.senderId ? (
              <Link className="break-words text-sm font-semibold text-primary hover:underline" to={`/objects/${message.senderId.toString()}`}>
                {senderName}
              </Link>
            ) : <span className="break-words text-sm font-semibold">{senderName}</span>}
            <span className="text-xs text-muted-foreground">
              {formattedDate}
            </span>
            {!isUser && responseModel && (
              <span
                className="max-w-[240px] truncate rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                title={`Response model: ${responseModel}`}
              >
                {responseModel}
              </span>
            )}
          </div>

          {/* Tool Calls */}
          {hasToolCalls && (
            <div className="space-y-2 w-full">
              {toolCalls.map((tc) => (
                <ToolCallDisplay key={tc.toolCallId} toolCall={tc} />
              ))}
            </div>
          )}

          {/* Bubble - only show if there's text content */}
          {hasContent && (
            <div
              className={cn(
                "relative rounded-2xl px-4 py-3",
                isUser
                  ? "bg-primary text-primary-foreground rounded-tr-sm"
                  : "border bg-card text-card-foreground rounded-tl-sm",
              )}
            >
              {/* Content */}
              <div
                className={cn(
                  "relative break-words text-base leading-relaxed",
                  isUser ? "" : "text-foreground",
                )}
              >
                {isUser
                  ? <span className="whitespace-pre-wrap">{content}</span>
                  : (
                    <Response className="prose dark:prose-invert max-w-none prose-p:my-2 prose-headings:my-3 prose-ul:my-2 prose-li:my-0.5">
                      {content}
                    </Response>
                  )}
              </div>
            </div>
          )}

          {hasUnparsedCalls && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
              The provider returned tool syntax as text. Those calls were
              skipped.
            </p>
          )}

          {/* Fallback for completely empty messages */}
          {!hasUnparsedCalls && !hasContent && !hasToolCalls && responseError &&
            (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm">
                <div className="font-medium text-red-700 dark:text-red-400">
                  Model returned an unusable response
                </div>
                <div className="mt-1 text-muted-foreground">
                  {responseError}
                </div>
                {requestId && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    Request ID:{" "}
                    <code className="break-all text-foreground">
                      {requestId}
                    </code>
                  </div>
                )}
              </div>
            )}

          {!hasUnparsedCalls && !hasContent && !hasToolCalls &&
            !responseError && (
            <div
              className={cn(
                "relative rounded-2xl px-4 py-3",
                "border border-red-500/30 bg-red-500/10 rounded-tl-sm",
              )}
            >
              <span className="text-muted-foreground text-sm">
                The model completed the request but returned no text or tool
                result.
              </span>
              {requestId && (
                <div className="mt-2 text-xs text-muted-foreground">
                  Request ID:{" "}
                  <code className="break-all text-foreground">{requestId}</code>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const MyceliaMessageComponent: Platform["MessageComponent"] = ({ message }) => {
  const raw = message.raw;

  const hasContent = raw?.content && (
    typeof raw.content === "string"
      ? raw.content.length > 0
      : (Array.isArray(raw.content) && raw.content.length > 0)
  );

  if (hasContent || raw?.role) {
    return <MyceliaMessageBubble message={message} />;
  }

  return <defaultPlatform.MessageComponent message={message} />;
};

export const myceliaPlatform: Platform = {
  ...defaultPlatform,
  id: "mycelia",
  name: "Mycelia",
  icon: () => <span>🍄</span>,
  MessageComponent: MyceliaMessageComponent,
};
