import { TimelineToolbar } from "./TimelineToolbar";
import { TimelineSelectionActions } from "./TimelineSelectionActions";
import { TrackVisibilityButton } from "./controls/TrackVisibilityPanel";
import { TimelinePlayerControls } from "./TimelinePlayerControls";
import { TimelineTimeZoneControl } from "./TimelineTimeZoneControl";

interface TimelineHeaderProps {
  hasTimeSelection: boolean;
  timeSelectionStart?: Date;
  timeSelectionEnd?: Date;
  isShortRange: boolean;
  onZoomToFit: () => void;
  onGoToAudio: (date: Date) => void;
  onTimeRangeSelect: (range: string) => void;
  onZoomToSelection: () => void;
  onCreateEvent: () => void;
  onClearTimeSelection: () => void;
}

export function TimelineHeader({
  hasTimeSelection,
  timeSelectionStart,
  timeSelectionEnd,
  isShortRange,
  onZoomToFit,
  onGoToAudio,
  onTimeRangeSelect,
  onZoomToSelection,
  onCreateEvent,
  onClearTimeSelection,
}: TimelineHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      {/* Player Controls - Left side */}
      <TimelinePlayerControls onGoToAudio={onGoToAudio} />

      {/* Right side controls */}
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {hasTimeSelection && timeSelectionStart && timeSelectionEnd && (
          <TimelineSelectionActions
            startDate={timeSelectionStart}
            endDate={timeSelectionEnd}
            isShortRange={isShortRange}
            onZoomToSelection={onZoomToSelection}
            onCreateEvent={onCreateEvent}
            onClearSelection={onClearTimeSelection}
          />
        )}
        <TimelineTimeZoneControl
          selectionStart={timeSelectionStart}
          selectionEnd={timeSelectionEnd}
        />
        <TimelineToolbar
          onZoomToFit={onZoomToFit}
          onTimeRangeSelect={onTimeRangeSelect}
        />
        <TrackVisibilityButton />
      </div>
    </div>
  );
}
