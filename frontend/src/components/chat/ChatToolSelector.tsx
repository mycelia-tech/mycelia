import { AlertTriangle, Check, ChevronDown, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  ChatToolCatalogEntry,
  ChatToolMode,
  ChatToolPolicy,
} from "@myceliasdk/messengers.ts";

const GROUPS: ChatToolCatalogEntry["group"][] = [
  "Search",
  "Knowledge",
  "Actions",
  "Docs",
  "Advanced data",
];

const MODE_LABELS: Record<ChatToolMode, string> = {
  auto: "Auto",
  none: "No tools",
  custom: "Custom",
};

export function ChatToolSelector({
  policy,
  catalog,
  disabled,
  onChange,
}: {
  policy: ChatToolPolicy;
  catalog: ChatToolCatalogEntry[];
  disabled?: boolean;
  onChange: (policy: ChatToolPolicy) => void;
}) {
  const available = new Set(catalog.map((tool) => tool.name));
  const unavailable = policy.enabledTools.filter((name) =>
    !available.has(name)
  );

  const selectMode = (mode: ChatToolMode) => {
    if (mode === "custom") {
      const enabledTools = policy.enabledTools.length > 0
        ? policy.enabledTools.filter((name) => available.has(name))
        : catalog.filter((tool) => tool.defaultEnabled).map((tool) =>
          tool.name
        );
      onChange({ mode, enabledTools });
      return;
    }
    onChange({ mode, enabledTools: [] });
  };

  const toggleTool = (name: string, checked: boolean) => {
    const enabled = new Set(policy.enabledTools);
    if (checked) enabled.add(name);
    else enabled.delete(name);
    onChange({ mode: "custom", enabledTools: [...enabled].sort() });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-9 w-full min-w-0 max-w-full justify-between gap-2 sm:w-auto"
          aria-label={`Tools: ${MODE_LABELS[policy.mode]}`}
        >
          <Wrench className="h-4 w-4 shrink-0" />
          <span className="truncate">Tools: {MODE_LABELS[policy.mode]}</span>
          {policy.mode === "custom" && (
            <Badge variant="secondary" className="px-1.5">
              {policy.enabledTools.filter((name) =>
                available.has(name)
              ).length}
            </Badge>
          )}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[var(--radix-popover-content-available-height)] w-[min(420px,calc(100vw-2rem))] overflow-y-auto p-0"
      >
        <div className="border-b p-3">
          <div className="font-medium">Tools for this chat</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The selected policy is saved and remains fixed while an answer is
            running.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-1 border-b p-2">
          {(["auto", "none", "custom"] as ChatToolMode[]).map((mode) => (
            <Button
              key={mode}
              type="button"
              size="sm"
              variant={policy.mode === mode ? "secondary" : "ghost"}
              aria-pressed={policy.mode === mode}
              onClick={() => selectMode(mode)}
              className="justify-start"
            >
              <Check
                className={cn(
                  "h-3.5 w-3.5",
                  policy.mode === mode ? "opacity-100" : "opacity-0",
                )}
              />
              {MODE_LABELS[mode]}
            </Button>
          ))}
        </div>
        {policy.mode === "custom" && (
          <div className="max-h-[360px] overflow-y-auto p-3">
            {GROUPS.map((group) => {
              const tools = catalog.filter((tool) => tool.group === group);
              if (tools.length === 0) return null;
              return (
                <div key={group} className="mb-4 last:mb-0">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {group}
                  </div>
                  <div className="space-y-2">
                    {tools.map((tool) => (
                      <label
                        key={tool.name}
                        className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted"
                      >
                        <Checkbox
                          checked={policy.enabledTools.includes(tool.name)}
                          onCheckedChange={(checked) =>
                            toggleTool(tool.name, checked === true)}
                          className="mt-0.5"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                            {tool.label}
                            {tool.needsApproval && (
                              <Badge
                                variant="outline"
                                className="px-1.5 py-0 text-xs"
                              >
                                approval
                              </Badge>
                            )}
                          </span>
                          <span className="block text-sm leading-snug text-muted-foreground">
                            {tool.description}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
            {unavailable.length > 0 && (
              <div className="mt-3 flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
                <span>
                  No longer available:{" "}
                  {unavailable.join(", ")}. Save the selection to remove them.
                </span>
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
