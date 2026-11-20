import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Loader2,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { formatToolName } from "@/lib/toolPresentation";
import type { ChatRunState } from "@myceliasdk/messengers.ts";
import type { MemoryChatMessage } from "@/lib/chat";

function toolStateLabel(state?: string): string {
  if (state === "approval-requested") return "Needs approval";
  if (state === "output-available") return "Completed";
  if (state === "output-error") return "Failed";
  if (state === "input-streaming") return "Preparing";
  return "Running";
}

export function ChatActivity({
  messages,
  sdkStatus,
  runState,
  error,
}: {
  messages: MemoryChatMessage[];
  sdkStatus: "submitted" | "streaming" | "ready" | "error";
  runState?: ChatRunState;
  error?: string;
}) {
  const latestAssistant = [...messages].reverse().find((message) =>
    message.role === "assistant"
  );
  const tools = useMemo(
    () =>
      (latestAssistant?.parts ?? []).filter((part: any) =>
        typeof part?.type === "string" &&
        (part.type.startsWith("tool-") || part.type === "dynamic-tool")
      ) as any[],
    [latestAssistant],
  );
  const active = sdkStatus === "submitted" || sdkStatus === "streaming";
  const needsApproval =
    tools.some((tool) => tool.state === "approval-requested") ||
    runState === "needs_approval";
  const failed = sdkStatus === "error" || runState === "failed" ||
    Boolean(error);
  const [open, setOpen] = useState(active || needsApproval || failed);

  useEffect(() => {
    if (active || needsApproval || failed) setOpen(true);
  }, [active, failed, needsApproval]);

  const metadata = latestAssistant?.metadata;
  const elapsedMs = active ? undefined : metadata?.durationMs;
  const completed =
    tools.filter((tool) => tool.state === "output-available").length;
  const toolErrors =
    tools.filter((tool) => tool.state === "output-error").length;
  const usage = metadata?.usage;
  const totalTokens = usage?.totalTokens ??
    ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) || undefined);

  if (
    !active && !needsApproval && !failed && tools.length === 0 &&
    !metadata?.usage
  ) {
    return null;
  }

  const title = needsApproval
    ? "Waiting for approval"
    : failed
    ? "Response failed"
    : active
    ? tools.length > 0 ? "Working with tools" : "Generating response"
    : "Response activity";

  const StatusIcon = needsApproval
    ? ShieldAlert
    : failed
    ? AlertCircle
    : active
    ? Loader2
    : CheckCircle2;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mx-auto mb-3 w-full max-w-3xl rounded-lg border bg-muted/20"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-3 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <StatusIcon
          className={cn(
            "h-4 w-4 shrink-0",
            active && "animate-spin",
            failed && "text-destructive",
            needsApproval && "text-amber-600",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {tools.length > 0 && (
              <span>{completed}/{tools.length} tools completed</span>
            )}
            {toolErrors > 0 && (
              <span className="text-destructive">{toolErrors} failed</span>
            )}
            {elapsedMs !== undefined && (
              <span className="flex items-center gap-1">
                <Clock3 className="h-3 w-3" />
                {(elapsedMs / 1000).toFixed(elapsedMs < 10_000 ? 1 : 0)}s
              </span>
            )}
          </span>
        </span>
        {open
          ? <ChevronDown className="h-4 w-4" />
          : <ChevronRight className="h-4 w-4" />}
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 py-2">
        {tools.length > 0 && (
          <div className="space-y-1.5">
            {tools.map((tool) => {
              const name = tool.type === "dynamic-tool"
                ? tool.toolName
                : tool.type.slice(5);
              return (
                <details
                  key={tool.toolCallId}
                  className="rounded-md bg-background/70 text-xs"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {formatToolName(name)}
                    </span>
                    <Badge
                      variant="outline"
                      className="px-1.5 py-0 text-[10px]"
                    >
                      {toolStateLabel(tool.state)}
                    </Badge>
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  </summary>
                  <div className="space-y-2 border-t px-2 py-2">
                    {tool.input !== undefined && (
                      <div>
                        <div className="mb-1 font-medium text-muted-foreground">
                          Parameters
                        </div>
                        <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2">
                          {JSON.stringify(tool.input, null, 2)}
                        </pre>
                      </div>
                    )}
                    {tool.output !== undefined && (
                      <div>
                        <div className="mb-1 font-medium text-muted-foreground">
                          Result
                        </div>
                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2">
                          {JSON.stringify(tool.output, null, 2)}
                        </pre>
                      </div>
                    )}
                    {tool.errorText && (
                      <div className="rounded bg-destructive/10 p-2 text-destructive">
                        {tool.errorText}
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
        <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
          {metadata?.model && (
            <div>
              Model: <code className="text-foreground">{metadata.model}</code>
            </div>
          )}
          {metadata?.providerProfileName && (
            <div>
              Provider:{" "}
              <span className="text-foreground">
                {metadata.providerProfileName}
              </span>
            </div>
          )}
          {totalTokens !== undefined && (
            <div>
              Tokens:{" "}
              <span className="text-foreground">
                {totalTokens.toLocaleString()}
              </span>
            </div>
          )}
          {metadata?.finishReason && (
            <div>
              Finish:{" "}
              <span className="text-foreground">{metadata.finishReason}</span>
            </div>
          )}
          {metadata?.requestId && (
            <div className="sm:col-span-2">
              Request:{" "}
              <code className="break-all text-foreground">
                {metadata.requestId}
              </code>
            </div>
          )}
        </div>
        {(error || metadata?.error?.message) && (
          <div className="mt-2 rounded bg-destructive/10 p-2 text-xs text-destructive">
            {error || metadata?.error?.message}
          </div>
        )}
        <p className="mt-2 text-[10px] text-muted-foreground">
          Shows observable operations and metrics; private model reasoning is
          not displayed.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
