import { useState, useEffect, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Markdown } from "@/components/Markdown";
import { Star } from "lucide-react";
import { formatRelativeTime } from "@/lib/formatTime";
import type { Object } from "@/types/objects";

type Summary = NonNullable<Object["summaries"]>[number];

interface SummaryCompareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summaries: Summary[];
  initialLeftIndex: number;
  onStarSummary: (index: number) => void;
}

function SummaryPanel({
  summary,
  index,
  summaries,
  onSelectIndex,
  onStar,
  isStarred,
  isFocused,
  panelRef,
}: {
  summary: Summary;
  index: number;
  summaries: Summary[];
  onSelectIndex: (index: number) => void;
  onStar: () => void;
  isStarred: boolean;
  isFocused: boolean;
  panelRef: React.RefObject<HTMLDivElement | null>;
}) {
  const formatCost = (cost: number | undefined) => {
    if (cost === undefined || cost === null) return "N/A";
    return `$${cost.toFixed(4)}`;
  };

  const formatTokens = (tokens: number | undefined) => {
    if (tokens === undefined || tokens === null) return "N/A";
    return tokens.toLocaleString();
  };

  const getModelDisplay = (summary: Summary) => {
    const alias = ["small", "medium", "large"].includes(summary.model)
      ? summary.model
      : "custom";
    return summary.modelName ? `${alias} | ${summary.modelName}` : alias;
  };

  return (
    <div 
      ref={panelRef}
      className={`flex flex-col h-full border-2 rounded-lg overflow-hidden transition-colors ${
        isFocused ? "border-primary ring-2 ring-primary/20" : "border-border"
      }`}
      tabIndex={0}
    >
      {/* Dropdown header */}
      <div className="p-3 border-b bg-muted/30 flex-shrink-0">
        <Select
          value={String(index)}
          onValueChange={(v) => onSelectIndex(Number(v))}
        >
          <SelectTrigger className="w-full h-9">
            <SelectValue>
              v{index + 1}: {summaries[index]?.model} - {formatRelativeTime(new Date(summaries[index]?.date))}
              {summaries[index]?.starred && " ★"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {summaries.map((s, i) => (
              <SelectItem key={i} value={String(i)}>
                <span className="flex items-center gap-2">
                  {s.starred && <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />}
                  <span>v{i + 1}: {s.model} - {formatRelativeTime(new Date(s.date))}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Summary content */}
      <ScrollArea className="flex-1 p-4">
        <div className="prose prose-sm max-w-none">
          <Markdown>{summary.text}</Markdown>
        </div>
      </ScrollArea>

      {/* Metadata footer */}
      <div className="p-4 border-t bg-muted/30 flex-shrink-0 space-y-3">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Prompt:</span>
            <span className="font-medium text-right">{summary.promptName || "Default"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Model:</span>
            <span className="font-medium text-right">{getModelDisplay(summary)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tokens:</span>
            <span className="font-medium text-right">{formatTokens(summary.usage?.totalTokens)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Cost:</span>
            <span className="font-medium text-right">{formatCost(summary.usage?.cost)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Version:</span>
            <span className="font-medium">{index + 1} of {summaries.length}</span>
            <Button
              variant={isStarred ? "default" : "outline"}
              size="sm"
              className="h-6 px-2 ml-auto"
              onClick={onStar}
            >
              <Star className={`w-3 h-3 mr-1 ${isStarred ? "fill-current" : ""}`} />
              {isStarred ? "Starred" : "Star"}
            </Button>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Date:</span>
            <span className="font-medium text-right">{formatRelativeTime(new Date(summary.date))}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SummaryCompareDialog({
  open,
  onOpenChange,
  summaries,
  initialLeftIndex,
  onStarSummary,
}: SummaryCompareDialogProps) {
  const [leftIndex, setLeftIndex] = useState(initialLeftIndex);
  const [rightIndex, setRightIndex] = useState(() => {
    // Default right panel to starred or latest
    const starredIndex = summaries.findIndex((s) => s.starred);
    if (starredIndex !== -1 && starredIndex !== initialLeftIndex) {
      return starredIndex;
    }
    // Latest (last in array), or first if left is already latest
    const latestIndex = summaries.length - 1;
    return latestIndex !== initialLeftIndex ? latestIndex : 0;
  });
  
  // Track which panel is focused (0 = left, 1 = right)
  const [focusedPanel, setFocusedPanel] = useState<0 | 1>(0);
  
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Track if we've initialized for this dialog open
  const hasInitialized = useRef(false);

  // Reset indices only when dialog opens (not on every summaries change)
  useEffect(() => {
    if (open && !hasInitialized.current) {
      hasInitialized.current = true;
      setLeftIndex(initialLeftIndex);
      const starredIndex = summaries.findIndex((s) => s.starred);
      if (starredIndex !== -1 && starredIndex !== initialLeftIndex) {
        setRightIndex(starredIndex);
      } else {
        const latestIndex = summaries.length - 1;
        setRightIndex(latestIndex !== initialLeftIndex ? latestIndex : 0);
      }
      setFocusedPanel(0);
    } else if (!open) {
      // Reset the flag when dialog closes
      hasInitialized.current = false;
    }
  }, [open, initialLeftIndex, summaries]);

  // Get the current index and setter for the focused panel
  const getCurrentIndex = useCallback(() => {
    return focusedPanel === 0 ? leftIndex : rightIndex;
  }, [focusedPanel, leftIndex, rightIndex]);

  const setCurrentIndex = useCallback((newIndex: number) => {
    if (focusedPanel === 0) {
      setLeftIndex(newIndex);
    } else {
      setRightIndex(newIndex);
    }
  }, [focusedPanel]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          setFocusedPanel(0);
          break;
        case "ArrowRight":
          e.preventDefault();
          setFocusedPanel(1);
          break;
        case "ArrowUp": {
          e.preventDefault();
          const currentIdx = getCurrentIndex();
          const prevIdx = currentIdx > 0 ? currentIdx - 1 : summaries.length - 1;
          setCurrentIndex(prevIdx);
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          const currIdx = getCurrentIndex();
          const nextIdx = currIdx < summaries.length - 1 ? currIdx + 1 : 0;
          setCurrentIndex(nextIdx);
          break;
        }
        case " ": {
          e.preventDefault();
          const idxToStar = focusedPanel === 0 ? leftIndex : rightIndex;
          onStarSummary(idxToStar);
          break;
        }
      }
    };

    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [open, focusedPanel, leftIndex, rightIndex, summaries.length, getCurrentIndex, setCurrentIndex, onStarSummary]);

  if (summaries.length < 2) {
    return null;
  }

  const leftSummary = summaries[leftIndex];
  const rightSummary = summaries[rightIndex];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent 
        ref={dialogRef}
        className="!max-w-[calc(100vw-4rem)] w-full h-[calc(100vh-4rem)] flex flex-col"
      >
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>Compare Summaries</DialogTitle>
          <DialogDescription className="text-xs">
            Use arrow keys to navigate: ←/→ switch panels, ↑/↓ change version, Space to star/unstar
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 grid grid-cols-2 gap-6 min-h-0">
          <SummaryPanel
            summary={leftSummary}
            index={leftIndex}
            summaries={summaries}
            onSelectIndex={setLeftIndex}
            onStar={() => onStarSummary(leftIndex)}
            isStarred={!!leftSummary.starred}
            isFocused={focusedPanel === 0}
            panelRef={leftPanelRef}
          />
          <SummaryPanel
            summary={rightSummary}
            index={rightIndex}
            summaries={summaries}
            onSelectIndex={setRightIndex}
            onStar={() => onStarSummary(rightIndex)}
            isStarred={!!rightSummary.starred}
            isFocused={focusedPanel === 1}
            panelRef={rightPanelRef}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
