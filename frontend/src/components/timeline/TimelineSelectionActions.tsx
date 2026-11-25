import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  CalendarPlus,
  CircleOff,
  MapPin,
  MapPinned,
  Maximize2,
  Play,
  UserRoundPlus,
  UsersRound,
  Wand2,
} from "lucide-react";
import { SummarizeDialog } from "@/components/dialogs/SummarizeDialog";
import { RunJobDialog } from "@/components/dialogs/RunJobDialog";
import { AssignLocationDialog } from "@/components/location/AssignLocationDialog";
import { AddTimelineVoiceSampleDialog } from "@/components/voice/AddTimelineVoiceSampleDialog";
import { useSelectedVoiceProfile } from "@/hooks/useSelectedVoiceProfile";
import { withVoiceProfile } from "@/lib/voiceProfileNavigation";

interface TimelineSelectionActionsProps {
  startDate: Date;
  endDate: Date;
  isShortRange: boolean;
  onZoomToSelection: () => void;
  onCreateEvent: () => void;
  onClearSelection: () => void;
}

export function TimelineSelectionActions({
  startDate,
  endDate,
  isShortRange,
  onZoomToSelection,
  onCreateEvent,
  onClearSelection,
}: TimelineSelectionActionsProps) {
  const voiceSelection = useSelectedVoiceProfile();
  const [isSummarizeOpen, setIsSummarizeOpen] = useState(false);
  const [isRunJobOpen, setIsRunJobOpen] = useState(false);
  const [isSetLocationOpen, setIsSetLocationOpen] = useState(false);
  const [isAddVoiceSampleOpen, setIsAddVoiceSampleOpen] = useState(false);

  return (
    <div role="group" aria-label="Selected time range actions" className="flex w-full flex-wrap items-center gap-1.5 rounded-md border border-primary/25 bg-primary/5 p-2">
      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="outline" size="sm">
              <Link
                to={`/map?start=${startDate.getTime()}&end=${endDate.getTime()}`}
              >
                <MapPinned className="h-4 w-4" /> Show on map
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Show the selected range on the map</p>
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={onZoomToSelection}
              variant="outline"
              size="sm"
            >
              <Maximize2 className="w-4 h-4" /> Zoom
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Zoom to selected range</p>
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsRunJobOpen(true)}
            >
              <Play className="w-4 h-4" /> Run Job
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Run job on selected range</p>
          </TooltipContent>
        </Tooltip>
      </div>
      <RunJobDialog
        open={isRunJobOpen}
        onOpenChange={setIsRunJobOpen}
        startDate={startDate}
        endDate={endDate}
      />

      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsAddVoiceSampleOpen(true)}
            >
              <UserRoundPlus className="h-4 w-4" /> Voice sample
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Save selected audio as a voice profile sample</p>
          </TooltipContent>
        </Tooltip>
      </div>
      <AddTimelineVoiceSampleDialog
        open={isAddVoiceSampleOpen}
        onOpenChange={setIsAddVoiceSampleOpen}
        startDate={startDate}
        endDate={endDate}
        initialProfileId={voiceSelection.selectedProfileId}
        onProfileSelected={voiceSelection.selectProfile}
      />

      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="outline" size="sm">
              <Link
                to={withVoiceProfile(
                  "/settings/voice-identity?reviewSource=timeline&newSession=1&start=" +
                    startDate.getTime() + "&end=" + endDate.getTime(),
                  voiceSelection.selectedProfileId,
                )}
              >
                <UsersRound className="h-4 w-4" /> Review voices
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Review diarized voices from this exact range</p>
          </TooltipContent>
        </Tooltip>
      </div>

      {isShortRange && (
        <>
          <div className="flex flex-col items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsSummarizeOpen(true)}
                >
                  <Wand2 className="w-4 h-4" /> Summarize
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Generate AI summary for range</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <SummarizeDialog
            open={isSummarizeOpen}
            onOpenChange={setIsSummarizeOpen}
            startDate={startDate}
            endDate={endDate}
          />
        </>
      )}

      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={onCreateEvent}
              variant="outline"
              size="sm"
            >
              <CalendarPlus className="w-4 h-4" /> Create
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Create new object from selected range</p>
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSetLocationOpen(true)}
            >
              <MapPin className="w-4 h-4" /> Location
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Set where you were during this range (also sets the timezone)</p>
          </TooltipContent>
        </Tooltip>
      </div>
      <AssignLocationDialog
        open={isSetLocationOpen}
        onOpenChange={setIsSetLocationOpen}
        initialStart={startDate}
        initialEnd={endDate}
      />

      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={onClearSelection}
              variant="outline"
              size="sm"
            >
              <CircleOff className="w-4 h-4" /> Clear
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Clear time selection</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
