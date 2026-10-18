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
    <div className="flex items-start gap-3 mr-auto">
      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="outline" size="icon">
              <Link
                to={`/map?start=${startDate.getTime()}&end=${endDate.getTime()}`}
              >
                <MapPinned className="h-4 w-4" />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Show the selected range on the map</p>
          </TooltipContent>
        </Tooltip>
        <span className="text-xs text-muted-foreground">Show on map</span>
      </div>

      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={onZoomToSelection}
              variant="outline"
              size="icon"
            >
              <Maximize2 className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Zoom to selected range</p>
          </TooltipContent>
        </Tooltip>
        <span className="text-xs text-muted-foreground">Zoom</span>
      </div>

      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setIsRunJobOpen(true)}
            >
              <Play className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Run job on selected range</p>
          </TooltipContent>
        </Tooltip>
        <span className="text-xs text-muted-foreground">Run Job</span>
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
              size="icon"
              onClick={() => setIsAddVoiceSampleOpen(true)}
            >
              <UserRoundPlus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Save selected audio as a voice profile sample</p>
          </TooltipContent>
        </Tooltip>
        <span className="text-xs text-muted-foreground">Voice sample</span>
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
            <Button asChild variant="outline" size="icon">
              <Link
                to={withVoiceProfile(
                  "/settings/voice-identity?reviewSource=timeline&newSession=1&start=" +
                    startDate.getTime() + "&end=" + endDate.getTime(),
                  voiceSelection.selectedProfileId,
                )}
              >
                <UsersRound className="h-4 w-4" />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Review diarized voices from this exact range</p>
          </TooltipContent>
        </Tooltip>
        <span className="text-xs text-muted-foreground">Review voices</span>
      </div>

      {isShortRange && (
        <>
          <div className="flex flex-col items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setIsSummarizeOpen(true)}
                >
                  <Wand2 className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Generate AI summary for range</p>
              </TooltipContent>
            </Tooltip>
            <span className="text-xs text-muted-foreground">Summarize</span>
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
              size="icon"
            >
              <CalendarPlus className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Create new object from selected range</p>
          </TooltipContent>
        </Tooltip>
        <span className="text-xs text-muted-foreground">Create</span>
      </div>

      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setIsSetLocationOpen(true)}
            >
              <MapPin className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Set where you were during this range (also sets the timezone)</p>
          </TooltipContent>
        </Tooltip>
        <span className="text-xs text-muted-foreground">Location</span>
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
              size="icon"
            >
              <CircleOff className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Clear time selection</p>
          </TooltipContent>
        </Tooltip>
        <span className="text-xs text-muted-foreground">Clear</span>
      </div>
    </div>
  );
}
