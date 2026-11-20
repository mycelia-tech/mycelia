import React, { memo } from "react";
import type { TrackConfig } from "@/types/tracks";

interface TrackHeaderProps {
  config: TrackConfig;
}

export const TrackHeader = memo(function TrackHeader({
  config,
}: TrackHeaderProps) {
  return (
    <div
      className="flex min-h-6 items-center gap-2 px-2 py-1 text-xs font-medium text-muted-foreground"
      style={{ pointerEvents: "none" }}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: config.color }}
      />
      {config.label}
    </div>
  );
});
