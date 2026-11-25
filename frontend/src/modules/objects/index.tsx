import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Layer, LayerComponentProps, Tool } from "@/core/core.ts";
import {
  getObjectCategory,
  useFilteredObjects,
  useObjectsStore,
} from "./useObjects.ts";
import { Button } from "@/components/ui/button.tsx";
import type { Object } from "@/types/objects.ts";
import { ArrowLeftRight, ArrowRight, PlusIcon, RefreshCw } from "lucide-react";
import { useTimelineRange } from "../../stores/timelineRange.ts";
import { useNow } from "@/hooks/useNow.ts";
import { useObjectSelectionStore } from "@/stores/objectSelectionStore.ts";
import { useSpanningObjectsStore } from "@/stores/spanningObjectsStore.ts";
import { useTrackVisibilityStore } from "@/stores/trackVisibilityStore.ts";
import { OBJECT_CATEGORIES, type ObjectCategory } from "@/types/tracks.ts";
import {
  buildRelationshipConnectors,
  type CategorySection,
  type ExtractedObjectRange,
  getRangeYOffset,
  type PlacedObjectRange,
} from "./relationshipConnectors.ts";
import { useObjectDensity } from "./useObjectDensity.ts";
import { ObjectDensityBars } from "./ObjectDensityBars.tsx";

const laneHeight = 40; // Half the previous height for more compact display
const topMargin = 4;
const categoryHeaderHeight = 24; // Height for category headers
const categoryLabelInset = 72;

const SMALL_OBJECT_THRESHOLD = 50;

function getLeftBoundaryPath(
  x: number,
  y: number,
  width: number,
  height: number,
  startOffScreen: boolean,
  cornerRadius: number,
  chevronOffset: number,
): string {
  if (startOffScreen) {
    return `M ${x + chevronOffset} ${y}
      L ${x + chevronOffset / 2} ${y + height / 2}
      L ${x + chevronOffset} ${y + height}
      L ${x + width} ${y + height}
      L ${x + width} ${y}
      Z`;
  } else {
    return `M ${x + cornerRadius} ${y}
      Q ${x} ${y} ${x} ${y + cornerRadius}
      L ${x} ${y + height - cornerRadius}
      Q ${x} ${y + height} ${x + cornerRadius} ${y + height}
      L ${x + width} ${y + height}
      L ${x + width} ${y}
      Z`;
  }
}

function getRightBoundaryPath(
  x: number,
  y: number,
  width: number,
  height: number,
  showEndChevron: boolean,
  cornerRadius: number,
  chevronOffset: number,
): string {
  const rightX = x + width;
  if (showEndChevron) {
    return `M ${rightX - chevronOffset} ${y}
      L ${rightX - chevronOffset / 2} ${y + height / 2}
      L ${rightX - chevronOffset} ${y + height}
      L ${x} ${y + height}
      L ${x} ${y}
      Z`;
  } else {
    return `M ${rightX - cornerRadius} ${y}
      Q ${rightX} ${y} ${rightX} ${y + cornerRadius}
      L ${rightX} ${y + height - cornerRadius}
      Q ${rightX} ${y + height} ${rightX - cornerRadius} ${y + height}
      L ${x} ${y + height}
      L ${x} ${y}
      Z`;
  }
}

function flattenObjectsToRanges(objects: Object[]): ExtractedObjectRange[] {
  const ranges: ExtractedObjectRange[] = [];

  for (const object of objects) {
    if (!object.timeRanges || object.timeRanges.length === 0) continue;

    const category = getObjectCategory(object);

    object.timeRanges.forEach((range, index) => {
      ranges.push({
        object,
        rangeIndex: index,
        start: range.start,
        end: range.end,
        category,
      });
    });
  }

  return ranges;
}
function useLaneLayout(
  ranges: ExtractedObjectRange[],
  xFor: (d: Date) => number,
  width: number,
  visibleStart: Date,
  visibleEnd: Date,
  layoutMode: "mixed" | "by-category",
  visibleCategories: ObjectCategory[],
) {
  const now = useNow(1000);

  return useMemo(() => {
    const spanningObjects: Object[] = [];
    const ongoingObjects: Object[] = [];
    const nowIsVisible = now >= visibleStart && now <= visibleEnd;

    // Filter and classify ranges
    const classifiedRanges: Array<
      ExtractedObjectRange & {
        originalStartX: number;
        originalEndX: number;
        startX: number;
        endX: number;
        rangeWidth: number;
        startOffScreen: boolean;
        endOffScreen: boolean;
        isSmall: boolean;
      }
    > = [];

    for (const range of ranges) {
      // Filter by visible categories
      if (!visibleCategories.includes(range.category)) continue;

      const originalStartX = xFor(range.start);
      const originalEndX = xFor(range.end ?? now);
      const startX = originalStartX < 0 ? 0 : originalStartX;
      const endX = originalEndX > width ? width : originalEndX;
      const rangeWidth = endX - startX;

      if (rangeWidth < 0.5) continue;

      const startOffScreen = originalStartX < 0;
      const endOffScreen = originalEndX > width;
      const isOngoing = range.end === null || range.end === undefined;

      if (nowIsVisible && isOngoing) {
        if (!ongoingObjects.some((o) => o._id === range.object._id)) {
          ongoingObjects.push(range.object);
        }
        continue;
      }

      if (startOffScreen && endOffScreen) {
        if (!spanningObjects.some((o) => o._id === range.object._id)) {
          spanningObjects.push(range.object);
        }
        continue;
      }

      classifiedRanges.push({
        ...range,
        originalStartX,
        originalEndX,
        startX,
        endX,
        rangeWidth,
        startOffScreen,
        endOffScreen,
        isSmall: rangeWidth <= SMALL_OBJECT_THRESHOLD,
      });
    }

    const placed: PlacedObjectRange[] = [];
    const categorySections: CategorySection[] = [];
    let totalLanes = 0;
    let currentYOffset = topMargin;

    if (layoutMode === "by-category") {
      // Group by category and layout each category separately
      for (const categoryConfig of OBJECT_CATEGORIES) {
        if (!visibleCategories.includes(categoryConfig.id)) continue;

        const categoryRanges = classifiedRanges.filter((r) =>
          r.category === categoryConfig.id
        );
        if (categoryRanges.length === 0) continue;

        const bigRanges = categoryRanges.filter((r) => !r.isSmall);
        const smallRanges = categoryRanges.filter((r) => r.isSmall);

        const sortedBig = [...bigRanges].sort((a, b) =>
          a.start.getTime() - b.start.getTime()
        );
        const sortedSmall = [...smallRanges].sort((a, b) =>
          a.start.getTime() - b.start.getTime()
        );

        const laneEnds: number[] = [];
        const startLane = totalLanes;

        // Layout big ranges for this category
        for (const range of sortedBig) {
          let lane = 0;
          while (lane < laneEnds.length && laneEnds[lane] > range.startX) {
            lane++;
          }

          if (lane === laneEnds.length) laneEnds.push(range.endX);
          else laneEnds[lane] = range.endX;

          placed.push({
            startX: range.startX,
            endX: range.endX,
            lane: totalLanes + lane,
            startOffScreen: range.startOffScreen,
            endOffScreen: range.endOffScreen,
            hasNoEnd: range.end === null,
            isSmall: false,
            object: range.object,
            rangeIndex: range.rangeIndex,
            start: range.start,
            end: range.end,
            category: range.category,
          });
        }

        const bigLaneCount = laneEnds.length;
        const smallLane = totalLanes + bigLaneCount;

        // Layout small ranges for this category (all on one lane)
        for (const range of sortedSmall) {
          placed.push({
            startX: range.startX,
            endX: range.endX,
            lane: smallLane,
            startOffScreen: range.startOffScreen,
            endOffScreen: range.endOffScreen,
            hasNoEnd: range.end === null,
            isSmall: true,
            object: range.object,
            rangeIndex: range.rangeIndex,
            start: range.start,
            end: range.end,
            category: range.category,
          });
        }

        const categoryLaneCount = bigLaneCount +
          (smallRanges.length > 0 ? 1 : 0);

        categorySections.push({
          category: categoryConfig.id,
          config: categoryConfig,
          startLane: startLane,
          laneCount: categoryLaneCount,
          yOffset: currentYOffset,
        });

        totalLanes += categoryLaneCount;
        currentYOffset += categoryHeaderHeight + categoryLaneCount * laneHeight;
      }
    } else {
      // Mixed mode - original algorithm
      const bigRanges = classifiedRanges.filter((r) => !r.isSmall);
      const smallRanges = classifiedRanges.filter((r) => r.isSmall);

      const sortedBig = [...bigRanges].sort((a, b) =>
        a.start.getTime() - b.start.getTime()
      );
      const sortedSmall = [...smallRanges].sort((a, b) =>
        a.start.getTime() - b.start.getTime()
      );

      const bigLaneEnds: number[] = [];

      for (const range of sortedBig) {
        let lane = 0;
        while (lane < bigLaneEnds.length && bigLaneEnds[lane] > range.startX) {
          lane++;
        }

        if (lane === bigLaneEnds.length) bigLaneEnds.push(range.endX);
        else bigLaneEnds[lane] = range.endX;

        placed.push({
          startX: range.startX,
          endX: range.endX,
          lane,
          startOffScreen: range.startOffScreen,
          endOffScreen: range.endOffScreen,
          hasNoEnd: range.end === null,
          isSmall: false,
          object: range.object,
          rangeIndex: range.rangeIndex,
          start: range.start,
          end: range.end,
          category: range.category,
        });
      }

      const bigLaneCount = bigLaneEnds.length;
      const smallLane = bigLaneCount;

      for (const range of sortedSmall) {
        placed.push({
          startX: range.startX,
          endX: range.endX,
          lane: smallLane,
          startOffScreen: range.startOffScreen,
          endOffScreen: range.endOffScreen,
          hasNoEnd: range.end === null,
          isSmall: true,
          object: range.object,
          rangeIndex: range.rangeIndex,
          start: range.start,
          end: range.end,
          category: range.category,
        });
      }

      totalLanes = bigLaneCount + (smallRanges.length > 0 ? 1 : 0);
    }

    return {
      placed,
      lanes: totalLanes,
      categorySections,
      spanningObjects,
      ongoingObjects,
    };
  }, [
    ranges,
    xFor,
    width,
    now,
    visibleStart,
    visibleEnd,
    layoutMode,
    visibleCategories,
  ]);
}

// Category header component
const CategoryHeader = React.memo(function CategoryHeader({
  section,
  width,
}: {
  section: CategorySection;
  width: number;
}) {
  return (
    <g>
      {/* Header background */}
      <rect
        x={0}
        y={section.yOffset}
        width={width}
        height={categoryHeaderHeight}
        fill={section.config.color}
        opacity={0.22}
      />
      {/* Header text */}
      <foreignObject
        x={categoryLabelInset}
        y={section.yOffset}
        width={Math.max(0, width - categoryLabelInset)}
        height={categoryHeaderHeight}
      >
        <div className="flex items-center h-full px-2">
          <div className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-background/90 px-2 py-0.5 text-xs font-semibold text-foreground shadow-sm">
            <span>{section.config.icon}</span>
            <span>{section.config.label}</span>
          </div>
        </div>
      </foreignObject>
      {/* Divider line */}
      <line
        x1={0}
        y1={section.yOffset + categoryHeaderHeight}
        x2={width}
        y2={section.yOffset + categoryHeaderHeight}
        stroke={section.config.color}
        strokeOpacity={0.55}
        strokeWidth={1}
      />
    </g>
  );
});

// Wrapper to adjust RangeBox Y position for category layout
const CategoryAwareRangeBox = React.memo(function CategoryAwareRangeBox({
  range,
  categorySections,
  layoutMode,
}: {
  range: PlacedObjectRange;
  categorySections: CategorySection[];
  layoutMode: "mixed" | "by-category";
}) {
  const yOffset = getRangeYOffset(
    range,
    categorySections,
    layoutMode,
    { laneHeight, topMargin, categoryHeaderHeight },
  );
  return <RangeBoxWithOffset range={range} yOffset={yOffset} />;
});

// RangeBox variant that accepts yOffset for category layout
const RangeBoxWithOffset = React.memo(function RangeBoxWithOffset({
  range,
  yOffset = 0,
}: {
  range: PlacedObjectRange;
  yOffset?: number;
}) {
  const { startX: rawStartX, startOffScreen, endOffScreen, object, isSmall } =
    range;
  const startX = rawStartX < 0 ? 0 : rawStartX;
  const { toggleSelection, isSelected, addToSelection, clearSelection } =
    useObjectSelectionStore();

  const selected = isSelected(object._id);

  const handleClick = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleSelection(object._id);
    } else {
      clearSelection();
      addToSelection(object._id);
    }
  };

  const renderIcon = (icon: any) => {
    if (!icon) return "";
    if (typeof icon === "string") return icon;
    if (icon.text) return icon.text;
    if (icon.base64) return "📷";
    return "";
  };

  const isRelationship = object.isRelationship;
  const hasRelationshipData = object.relationship && object.subjectObject &&
    object.objectObject;
  let rangeWidth = range.endX - startX;
  if (Number.isNaN(rangeWidth) || rangeWidth <= 0) return null;
  if (rangeWidth < 2) rangeWidth = 2;

  const height = laneHeight - 2;
  const x = startX;
  const y = yOffset + topMargin + range.lane * laneHeight;
  const cornerRadius = 4;
  const chevronOffset = 8;
  const showEndChevron = range.hasNoEnd || endOffScreen;

  const clipPathId = `clip-${range.object._id.toString()}-${range.rangeIndex}`;
  const filterId = `blur-${range.object._id.toString()}-${range.rangeIndex}`;

  const leftBoundaryPath = getLeftBoundaryPath(
    x,
    y,
    rangeWidth,
    height,
    startOffScreen,
    cornerRadius,
    chevronOffset,
  );
  const rightBoundaryPath = getRightBoundaryPath(
    x,
    y,
    rangeWidth,
    height,
    showEndChevron,
    cornerRadius,
    chevronOffset,
  );

  return (
    <g
      style={{ cursor: "pointer" }}
      onClick={handleClick}
    >
      <defs>
        <clipPath id={`${clipPathId}-left`}>
          <path d={leftBoundaryPath} />
        </clipPath>
        <clipPath id={clipPathId}>
          <path d={rightBoundaryPath} clipPath={`url(#${clipPathId}-left)`} />
        </clipPath>
        {isSmall && (
          <filter id={filterId}>
            <feGaussianBlur stdDeviation="1.5" />
          </filter>
        )}
      </defs>

      {/* Background rectangle */}
      <rect
        x={x}
        y={y}
        width={rangeWidth}
        height={height}
        fill={object.color as string || "#6b7280"}
        stroke={selected ? "#2563eb" : "none"}
        strokeWidth={selected ? 3 : 0}
        clipPath={`url(#${clipPathId})`}
        filter={isSmall ? `url(#${filterId})` : undefined}
        opacity={isSmall ? 0.7 : 1}
      />

      {/* Content container - only show for non-small objects */}
      {!isSmall && (
        <foreignObject
          width={rangeWidth}
          height={laneHeight - 2}
          x={startX}
          y={y}
          className="p-2"
          clipPath={`url(#${clipPathId})`}
        >
          <div className="h-full flex flex-col justify-center items-start text-white">
            {isRelationship && hasRelationshipData
              ? (
                // Relationship display
                <div className="space-y-0.5 w-full">
                  {/* Relationship name and icon */}
                  <div className="flex items-center gap-1 text-xs font-medium justify-start">
                    <span className="text-sm">{renderIcon(object.icon)}</span>
                    <span className="truncate">{object.name}</span>
                  </div>

                  {/* Subject and Object with arrow - keep them close together */}
                  <div className="flex items-center gap-1 text-xs justify-start min-w-0 w-full">
                    <div className="flex items-center gap-0.5 min-w-0 max-w-full overflow-hidden justify-start">
                      <span className="text-sm flex-shrink-0">
                        {renderIcon(object.subjectObject?.icon)}
                      </span>
                      <span className="font-medium truncate min-w-0">
                        {object.subjectObject?.name}
                      </span>
                    </div>

                    <div className="flex-shrink-0">
                      {object.relationship?.symmetrical
                        ? <ArrowLeftRight className="w-2.5 h-2.5" />
                        : <ArrowRight className="w-2.5 h-2.5" />}
                    </div>

                    <div className="flex items-center gap-0.5 min-w-0 max-w-full overflow-hidden justify-start">
                      <span className="text-sm flex-shrink-0">
                        {renderIcon(object.objectObject?.icon)}
                      </span>
                      <span className="font-medium truncate min-w-0">
                        {object.objectObject?.name}
                      </span>
                    </div>
                  </div>
                </div>
              )
              : (
                // Regular object display
                <div className="space-y-0.5 w-full">
                  <div className="flex items-center gap-1 text-xs font-medium justify-start">
                    <span className="text-sm">{renderIcon(object.icon)}</span>
                    <span className="truncate">{object.name}</span>
                  </div>
                </div>
              )}
          </div>
        </foreignObject>
      )}
    </g>
  );
});

export const ObjectsLayer: () => Layer = () => {
  return {
    component: ({ scale, transform, width }: LayerComponentProps) => {
      const { objects, loading, error, detailDeferred } = useFilteredObjects({
        width,
      });
      const density = useObjectDensity({ width, enabled: detailDeferred });
      const setSpanningObjects = useSpanningObjectsStore(
        (state) => state.setSpanningObjects,
      );
      const setOngoingObjects = useSpanningObjectsStore(
        (state) => state.setOngoingObjects,
      );
      const { objectsLayoutMode, visibleObjectCategories } =
        useTrackVisibilityStore();

      const ranges = useMemo(() => flattenObjectsToRanges(objects), [objects]);
      const { start, end } = useTimelineRange();

      const xFor = useMemo(() => {
        return (d: Date) => transform.applyX(scale(d));
      }, [scale, transform]);

      const layout = useLaneLayout(
        ranges,
        xFor,
        width,
        start,
        end,
        objectsLayoutMode,
        visibleObjectCategories,
      );

      useEffect(() => {
        setSpanningObjects(layout.spanningObjects);
      }, [layout.spanningObjects, setSpanningObjects]);

      useEffect(() => {
        setOngoingObjects(layout.ongoingObjects);
      }, [layout.ongoingObjects, setOngoingObjects]);

      const relationshipConnectors = useMemo(
        () =>
          buildRelationshipConnectors(
            layout.placed,
            layout.categorySections,
            objectsLayoutMode,
            { laneHeight, topMargin, categoryHeaderHeight },
          ),
        [layout.categorySections, layout.placed, objectsLayoutMode],
      );

      // Calculate height including category headers
      const height = objectsLayoutMode === "by-category"
        ? layout.categorySections.reduce(
          (max, s) =>
            Math.max(
              max,
              s.yOffset + categoryHeaderHeight + s.laneCount * laneHeight,
            ),
          0,
        ) + 10
        : topMargin + layout.lanes * laneHeight + 10;

      return (
        <svg
          className="w-full h-full zoomable"
          width={width}
          height={Math.max(height, 50)}
        >
          {/* Category headers in by-category mode */}
          {objectsLayoutMode === "by-category" &&
            layout.categorySections.map((section) => (
              <CategoryHeader
                key={section.category}
                section={section}
                width={width}
              />
            ))}

          {/* Relationship connectors */}
          <g aria-hidden="true" pointerEvents="none">
            {relationshipConnectors.map((connector) => (
              <g key={connector.key}>
                <path
                  d={connector.path}
                  fill="none"
                  stroke={connector.color}
                  strokeOpacity={0.4}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={connector.endX}
                  cy={connector.endY}
                  r={1.75}
                  fill={connector.color}
                  fillOpacity={0.55}
                />
              </g>
            ))}
          </g>

          {/* Object ranges */}
          {layout.placed.map((range: PlacedObjectRange) => (
            <CategoryAwareRangeBox
              key={`${range.object._id.toString()}-${range.rangeIndex}`}
              range={range}
              categorySections={layout.categorySections}
              layoutMode={objectsLayoutMode}
            />
          ))}

          {loading && (
            <g className="loading-indicator" opacity={0.6}>
              <rect
                x={xFor(start)}
                y={4}
                width={Math.max(2, xFor(end) - xFor(start))}
                height={3}
                fill="currentColor"
                className="text-primary animate-pulse"
                rx={1}
              />
            </g>
          )}
          {error && !loading && (
            <text
              x={8}
              y={18}
              fontSize={11}
              fill="#dc2626"
            >
              Object detail unavailable — zoom or refresh to retry
            </text>
          )}
          {detailDeferred &&
            (density.ready || density.buckets.length > 0) && (
            <ObjectDensityBars buckets={density.buckets} xFor={xFor} />
          )}
          {detailDeferred && density.loading && !density.ready &&
            density.buckets.length === 0 && (
            <text x={8} y={18} fontSize={11} fill="currentColor" opacity={0.6}>
              Loading object density…
            </text>
          )}
          {detailDeferred && !density.loading && !density.ready &&
            !density.error && density.buckets.length === 0 && (
            <text
              x={8}
              y={18}
              fontSize={11}
              fill="currentColor"
              opacity={0.6}
            >
              Object density is being built — zoom in for details
            </text>
          )}
          {detailDeferred && density.error && (
            <text x={8} y={18} fontSize={11} fill="#b45309">
              Object density unavailable — zoom in for details
            </text>
          )}
        </svg>
      );
    },
  } as Layer;
};

export const CreateObjectTool: Tool = {
  component: () => {
    const navigate = useNavigate();
    return (
      <Button onClick={() => navigate("/objects/create")}>
        <PlusIcon className="w-4 h-4" />
      </Button>
    );
  },
  tooltip: "Create new object",
};

export const RefreshObjectsTool: Tool = {
  component: () => {
    const [isRefreshing, setIsRefreshing] = useState(false);
    const fetchForRange = useObjectsStore((state) => state.fetchForRange);
    const { start, end } = useTimelineRange();

    const handleRefresh = async () => {
      setIsRefreshing(true);
      try {
        await fetchForRange(start, end);
      } finally {
        setIsRefreshing(false);
      }
    };

    return (
      <Button
        onClick={handleRefresh}
        disabled={isRefreshing}
        variant="outline"
        size="sm"
        aria-label="Refresh objects"
      >
        <RefreshCw
          className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`}
        />
        Refresh
      </Button>
    );
  },
  tooltip: "Refresh objects for current time range",
};
