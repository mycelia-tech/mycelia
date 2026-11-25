import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Clock, Maximize2 } from "lucide-react";
import { config } from "@/config";

interface TimelineToolbarProps {
  onZoomToFit: () => void;
  onTimeRangeSelect: (range: string) => void;
}

const ToolWrapper = ({ tool }: { tool: any }) => {
  const Component = tool.component;

  return (
    <div className="flex flex-col items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Component />
          </span>
        </TooltipTrigger>
        {tool.tooltip && (
          <TooltipContent>
            <p>{tool.tooltip}</p>
          </TooltipContent>
        )}
      </Tooltip>
      {tool.label && (
        <span className="text-xs text-muted-foreground">{tool.label}</span>
      )}
    </div>
  );
};

export function TimelineToolbar({
  onZoomToFit,
  onTimeRangeSelect,
}: TimelineToolbarProps) {
  return (
    <>
      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button variant="outline" size="sm" onClick={onZoomToFit}>
                <Maximize2 className="h-4 w-4" /> Fit all
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <p>Fit timeline to show all entities</p>
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-col items-center gap-1">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" aria-label="Time range">
                  <Clock className="h-4 w-4" /> Range
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>
              <p>Jump to a specific time range</p>
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onTimeRangeSelect("last5min")}>
              Last 5 minutes
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTimeRangeSelect("lastHour")}>
              Last hour
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTimeRangeSelect("today")}>
              Today
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTimeRangeSelect("yesterday")}>
              Yesterday
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTimeRangeSelect("thisWeek")}>
              This week
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTimeRangeSelect("currentMonth")}>
              Current month
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTimeRangeSelect("yearToDate")}>
              Year to date
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTimeRangeSelect("pastYear")}>
              Past year
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {config.tools.map((tool, i) => (
        <ToolWrapper key={i} tool={tool} />
      ))}
    </>
  );
}
