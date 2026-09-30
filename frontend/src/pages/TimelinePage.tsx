import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { MultiTrackTimeline } from "@/components/timeline/MultiTrackTimeline";
import { TimelineHeader } from "@/components/timeline/TimelineHeader";
import { SelectedObjectsPanel } from "@/components/timeline/SelectedObjectsPanel";
import { TrackVisibilityPanel } from "@/components/timeline/controls/TrackVisibilityPanel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useObjectsStore } from "@/modules/objects/useObjects";
import { useObjectSelectionStore } from "@/stores/objectSelectionStore";
import { LocationSelectionPanel } from "@/components/location/LocationSelectionPanel";
import { useTrackVisibilityStore } from "@/stores/trackVisibilityStore";
import { useTimelineSelectionStore } from "@/stores/timelineSelectionStore";
import { useSpanningObjectsStore } from "@/stores/spanningObjectsStore";
import { useTimeline } from "@/hooks/useTimeline";
import { useTimelineRange } from "@/stores/timelineRange";
import { api } from "@/lib/api";
import { useTimelineTimeZoneStore } from "@/stores/timelineTimeZoneStore";
import { useTimelineTimeZone } from "@/hooks/useTimelineTimeZone";
import { getTimelinePresetRange, type TimelinePreset } from "@/lib/timeZones";
import { getAudioFocusRange } from "@/lib/audioTimeline";
import { TimelineRecoveryStatus } from "@/components/timeline/TimelineRecoveryStatus";
import { combineTimelineDataRanges } from "@/lib/timelineRangeBounds";
import {
  getPhotoTimelineFocusRange,
  type PhotoTimelineFocus,
  photoTimelineFocusFromAssetDetail,
} from "@/lib/photoTimelineDeepLink";

const TimelinePage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const objects = useObjectsStore((state) => state.objects);
  const { clearSelection: clearObjectSelection, selectedIds } =
    useObjectSelectionStore();
  const { selection: timeSelection, clearSelection: clearTimeSelection } =
    useTimelineSelectionStore();
  const spanningObjects = useSpanningObjectsStore(
    (state) => state.spanningObjects,
  );
  const ongoingObjects = useSpanningObjectsStore(
    (state) => state.ongoingObjects,
  );

  const timeline = useTimeline();
  const { zoomTo } = timeline;
  const zoomToRef = useRef(zoomTo);
  zoomToRef.current = zoomTo;
  const { start: timelineStart, end: timelineEnd, setRange } =
    useTimelineRange();
  const fetchTimeZones = useTimelineTimeZoneStore((state) =>
    state.fetchForRange
  );
  const { resolveTimeZone } = useTimelineTimeZone();
  const hasTimeSelection = !!(timeSelection.start && timeSelection.end);
  const [focusedPhoto, setFocusedPhoto] = useState<PhotoTimelineFocus>();
  const photoAssetId = useMemo(() => {
    const value = new URLSearchParams(location.search).get("photoAssetId");
    return value?.trim() || undefined;
  }, [location.search]);
  const setTrackVisible = useTrackVisibilityStore((state) =>
    state.setTrackVisible
  );

  useEffect(() => {
    if (photoAssetId) setTrackVisible("photos", true);
  }, [photoAssetId, setTrackVisible]);

  useEffect(() => {
    if (!photoAssetId) {
      setFocusedPhoto(undefined);
      return;
    }
    let current = true;
    setFocusedPhoto(undefined);
    api.callResource("media", { action: "getAsset", assetId: photoAssetId })
      .then((result) => {
        if (!current) return;
        const focus = photoTimelineFocusFromAssetDetail(result, photoAssetId);
        setFocusedPhoto(focus);
        if (focus.capturedAt) {
          const range = getPhotoTimelineFocusRange(focus.capturedAt);
          zoomToRef.current(range.start, range.end);
        }
      })
      .catch(() => {
        if (current) {
          toast.error("Photo could not be opened on the Timeline");
        }
      });
    return () => {
      current = false;
    };
  }, [photoAssetId]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => {
      fetchTimeZones(timelineStart, timelineEnd);
    }, 150);
    return () => globalThis.clearTimeout(timeout);
  }, [fetchTimeZones, timelineEnd, timelineStart]);

  // Apply start/end from URL when navigating to timeline with ?start=&end= (e.g. "View on timeline" from object)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const startParam = params.get("start");
    const endParam = params.get("end");
    if (!startParam) return;
    const startMs = parseInt(startParam, 10);
    if (Number.isNaN(startMs)) return;
    const start = new Date(startMs);
    const end = endParam ? new Date(parseInt(endParam, 10)) : new Date();
    if (endParam && Number.isNaN(end.getTime())) return;
    setRange(start, end);
  }, [location.search, setRange]);

  const isShortRange = Boolean(
    timeSelection.start &&
      timeSelection.end &&
      timeSelection.end.getTime() - timeSelection.start.getTime() <
        24 * 60 * 60 * 1000,
  );

  // Clear selection when navigating away
  useEffect(() => {
    return () => {
      clearObjectSelection();
      clearTimeSelection();
    };
  }, [clearObjectSelection, clearTimeSelection]);

  const selectedObjects = useMemo(() => {
    if (!objects || selectedIds.size === 0) return [];
    return objects.filter((object) => selectedIds.has(object._id.toString()));
  }, [objects, selectedIds]);

  const showLocations = useTrackVisibilityStore((state) =>
    state.visibleTracks.includes("locations")
  );
  // When an object marker is selected, show where it happened on the mini-map.
  const selectedObjectTime = useMemo(() => {
    const first = selectedObjects[0]?.timeRanges?.[0]?.start;
    return first ? new Date(first) : null;
  }, [selectedObjects]);

  const panelObjects = useMemo(() => {
    const excludedIds = new Set([
      ...spanningObjects.map((o) => o._id.toString()),
      ...ongoingObjects.map((o) => o._id.toString()),
    ]);
    const selectedNotExcluded = selectedObjects.filter(
      (o) => !excludedIds.has(o._id.toString()),
    );
    return [...ongoingObjects, ...spanningObjects, ...selectedNotExcluded];
  }, [spanningObjects, ongoingObjects, selectedObjects]);

  const handleZoomToSelection = () => {
    if (timeSelection.start && timeSelection.end) {
      zoomTo(timeSelection.start, timeSelection.end);
    }
  };

  const handleGoToAudio = useCallback((date: Date) => {
    const { start, end } = getAudioFocusRange(date);
    zoomTo(start, end);
  }, [zoomTo]);

  const handleCreateEvent = () => {
    if (!timeSelection.start) return;

    const params = new URLSearchParams();
    params.set("start", timeSelection.start.getTime().toString());
    if (timeSelection.end) {
      params.set("end", timeSelection.end.getTime().toString());
    }
    navigate(`/objects/create?${params.toString()}`);
  };

  const handleZoomToFit = useCallback(async () => {
    try {
      const results = await Promise.allSettled([
        api.callResource("objects", { action: "getTimeRange" }),
        api.callResource("media-library", { action: "timeRange" }),
      ]);
      const range = combineTimelineDataRanges(
        results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : []
        ),
      );

      if (range) {
        const duration = range.end.getTime() - range.start.getTime();
        const padding = Math.max(duration * 0.05, 5 * 60 * 1000);
        const paddedStart = new Date(range.start.getTime() - padding);
        const paddedEnd = new Date(range.end.getTime() + padding);
        zoomTo(paddedStart, paddedEnd);
      }
    } catch (err) {
      console.error("Failed to get time range:", err);
    }
  }, [zoomTo]);

  const handleFocusedPhotoDismiss = useCallback(() => {
    setFocusedPhoto(undefined);
    const params = new URLSearchParams(location.search);
    params.delete("photoAssetId");
    params.set("start", timelineStart.getTime().toString());
    params.set("end", timelineEnd.getTime().toString());
    navigate({
      pathname: location.pathname,
      search: params.toString() ? `?${params.toString()}` : "",
    }, { replace: true });
  }, [
    location.pathname,
    location.search,
    navigate,
    timelineEnd,
    timelineStart,
  ]);

  const handleTimeRangeSelect = (range: string) => {
    const now = new Date();
    const supported = [
      "last5min",
      "lastHour",
      "today",
      "yesterday",
      "thisWeek",
      "currentMonth",
      "yearToDate",
      "pastYear",
    ] as const;
    if (!supported.includes(range as TimelinePreset)) return;
    const timeZone = resolveTimeZone(now);
    const { start, end } = getTimelinePresetRange(
      range as TimelinePreset,
      now,
      timeZone,
    );
    zoomTo(start, end);
  };

  return (
    <TooltipProvider>
      <div className="flex gap-4">
        {/* Main timeline content */}
        <div className="flex-1 space-y-6 min-w-0">
          <TimelineHeader
            hasTimeSelection={hasTimeSelection}
            timeSelectionStart={timeSelection.start ?? undefined}
            timeSelectionEnd={timeSelection.end ?? undefined}
            isShortRange={isShortRange}
            onZoomToFit={handleZoomToFit}
            onGoToAudio={handleGoToAudio}
            onTimeRangeSelect={handleTimeRangeSelect}
            onZoomToSelection={handleZoomToSelection}
            onCreateEvent={handleCreateEvent}
            onClearTimeSelection={clearTimeSelection}
          />

          <TimelineRecoveryStatus />

          <div className="border rounded-lg p-2">
            <MultiTrackTimeline
              timeline={timeline}
              focusedPhoto={focusedPhoto}
              onFocusedPhotoDismiss={handleFocusedPhotoDismiss}
            />
          </div>

          <LocationSelectionPanel
            fallbackTime={selectedObjectTime}
            enabled={showLocations}
          />

          <SelectedObjectsPanel
            selectedObjects={panelObjects}
            onClear={clearObjectSelection}
            hasSelections={selectedIds.size > 0}
          />
        </div>

        {/* Side panel for track visibility */}
        <TrackVisibilityPanel />
      </div>
    </TooltipProvider>
  );
};

export default TimelinePage;
