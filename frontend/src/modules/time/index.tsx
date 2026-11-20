import { useEffect, useMemo, useRef } from "react";
import { Layer, LayerComponentProps } from "@/core/core.ts";
import { useTimelineSelectionStore } from "@/stores/timelineSelectionStore.ts";

import { Formatter } from "./formatters/types.ts";
import { layoutRulerLabels, rulerTicks } from "./ruler.ts";

import gregorianFormatter from "./formatters/gregorian.ts";
import siFormatter from "./formatters/si.ts";
import { useTimelineTimeZone } from "@/hooks/useTimelineTimeZone";

export const GregorianFormatter: Formatter = gregorianFormatter;
export const SiFormatter: Formatter = siFormatter;

export * from "./ClearSelectionTool";

export type TimeLayerOptions = {
  formatter: Formatter;
};

export const TimeLayer: (options?: TimeLayerOptions) => Layer = (
  options = { formatter: gregorianFormatter },
) => {
  return {
    component: ({ scale, transform, width }: LayerComponentProps) => {
      const { resolveTimeZone } = useTimelineTimeZone();
      const { selection, setSelection } = useTimelineSelectionStore();
      const svgRef = useRef<SVGSVGElement>(null);
      const isSelectingRef = useRef(false);
      const selectionStartXRef = useRef<number | null>(null);
      const selectionStartTimeRef = useRef<Date | null>(null);
      const hasMovedRef = useRef(false);
      const draggingHandleRef = useRef<"left" | "right" | null>(null);
      const handleStartTimeRef = useRef<Date | null>(null);
      const selectionRef = useRef(selection);
      const scaleRef = useRef(scale);
      const transformRef = useRef(transform);

      useEffect(() => {
        selectionRef.current = selection;
      }, [selection]);

      useEffect(() => {
        scaleRef.current = scale;
        transformRef.current = transform;
      }, [scale, transform]);

      useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return;

        const handleDocumentMouseMove = (e: MouseEvent) => {
          if (!setSelection || !svg) return;

          const rect = svg.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const rescaledScale = transformRef.current.rescaleX(scaleRef.current);
          const clampedX = Math.max(0, Math.min(width, x));
          const newTime = rescaledScale.invert(clampedX);

          if (draggingHandleRef.current === "left") {
            const currentSelection = selectionRef.current;
            if (!currentSelection?.end) return;
            const end = currentSelection.end;
            if (newTime <= end) {
              setSelection({ start: newTime, end });
            } else {
              setSelection({ start: end, end: newTime });
            }
          } else if (draggingHandleRef.current === "right") {
            const currentSelection = selectionRef.current;
            if (!currentSelection?.start) return;
            const start = currentSelection.start;
            if (newTime >= start) {
              setSelection({ start, end: newTime });
            } else {
              setSelection({ start: newTime, end: start });
            }
          } else if (
            isSelectingRef.current && selectionStartXRef.current !== null &&
            selectionStartTimeRef.current !== null
          ) {
            const deltaX = Math.abs(x - selectionStartXRef.current);

            if (deltaX > 3) {
              hasMovedRef.current = true;
            }

            if (hasMovedRef.current) {
              const endTime = rescaledScale.invert(clampedX);
              const startTime = selectionStartTimeRef.current;

              if (startTime <= endTime) {
                setSelection({ start: startTime, end: endTime });
              } else {
                setSelection({ start: endTime, end: startTime });
              }
            }
          } else {
            return;
          }

          e.preventDefault();
          e.stopPropagation();
        };

        const handleDocumentMouseUp = (e: MouseEvent) => {
          if (!isSelectingRef.current && !draggingHandleRef.current) return;

          if (draggingHandleRef.current) {
            draggingHandleRef.current = null;
            handleStartTimeRef.current = null;
          } else if (isSelectingRef.current) {
            if (
              !hasMovedRef.current && setSelection &&
              selectionStartTimeRef.current
            ) {
              setSelection({ start: null, end: null });
            }

            isSelectingRef.current = false;
            selectionStartXRef.current = null;
            selectionStartTimeRef.current = null;
            hasMovedRef.current = false;
          }

          document.removeEventListener("mousemove", handleDocumentMouseMove, {
            capture: true,
          });
          document.removeEventListener("mouseup", handleDocumentMouseUp, {
            capture: true,
          });

          e.preventDefault();
          e.stopPropagation();
        };

        const handleHandleMouseDown = (
          e: MouseEvent,
          handle: "left" | "right",
        ) => {
          if (e.button !== 0) return;
          if (!setSelection) return;
          const currentSelection = selectionRef.current;
          if (!currentSelection?.start || !currentSelection?.end) return;

          draggingHandleRef.current = handle;
          handleStartTimeRef.current = handle === "left"
            ? currentSelection.start
            : currentSelection.end;

          document.addEventListener("mousemove", handleDocumentMouseMove, {
            capture: true,
          });
          document.addEventListener("mouseup", handleDocumentMouseUp, {
            capture: true,
          });

          e.preventDefault();
          e.stopPropagation();
        };

        const handleNativeMouseDown = (e: MouseEvent) => {
          if (e.button !== 0) return;
          if (!setSelection) return;

          const target = e.target as Element;
          if (target.classList.contains("selection-handle")) {
            const handle = target.classList.contains("selection-handle-left")
              ? "left"
              : "right";
            handleHandleMouseDown(e, handle);
            return;
          }

          const rect = svg.getBoundingClientRect();
          const x = e.clientX - rect.left;

          isSelectingRef.current = true;
          selectionStartXRef.current = x;
          hasMovedRef.current = false;

          const rescaledScale = transformRef.current.rescaleX(scaleRef.current);
          const startTime = rescaledScale.invert(x);
          selectionStartTimeRef.current = startTime;

          document.addEventListener("mousemove", handleDocumentMouseMove, {
            capture: true,
          });
          document.addEventListener("mouseup", handleDocumentMouseUp, {
            capture: true,
          });

          e.preventDefault();
          e.stopPropagation();
        };

        svg.addEventListener("mousedown", handleNativeMouseDown, {
          capture: true,
        });

        return () => {
          svg.removeEventListener("mousedown", handleNativeMouseDown, {
            capture: true,
          });
          document.removeEventListener("mousemove", handleDocumentMouseMove, {
            capture: true,
          });
          document.removeEventListener("mouseup", handleDocumentMouseUp, {
            capture: true,
          });
        };
      }, [width, setSelection]);

      const selectionRect = useMemo(() => {
        if (!selection?.start || !selection?.end) return null;

        const rescaledScale = transform.rescaleX(scale);
        const x1 = rescaledScale(selection.start);
        const x2 = rescaledScale(selection.end);

        const left = Math.min(x1, x2);
        const rectWidth = Math.abs(x2 - x1);

        if (Number.isNaN(rectWidth)) return null;

        return {
          left,
          width: rectWidth,
          start: selection.start,
          end: selection.end,
        };
      }, [selection, scale, transform]);

      const formatSelectionDate = (date: Date) => {
        const timeZone = resolveTimeZone(date);
        return new Intl.DateTimeFormat(undefined, {
          timeZone,
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZoneName: "short",
        }).format(date);
      };

      const formatDuration = (start: Date, end: Date) => {
        const diffMs = end.getTime() - start.getTime();
        const diffSeconds = Math.floor(diffMs / 1000);
        const diffMinutes = Math.floor(diffSeconds / 60);
        const diffHours = Math.floor(diffMinutes / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffDays > 0) {
          const remainingHours = diffHours % 24;
          if (remainingHours > 0) {
            return `${diffDays}d ${remainingHours}h`;
          }
          return `${diffDays} day${diffDays !== 1 ? "s" : ""}`;
        } else if (diffHours > 0) {
          const remainingMinutes = diffMinutes % 60;
          if (remainingMinutes > 0) {
            return `${diffHours}h ${remainingMinutes}m`;
          }
          return `${diffHours} hour${diffHours !== 1 ? "s" : ""}`;
        } else if (diffMinutes > 0) {
          return `${diffMinutes} min${diffMinutes !== 1 ? "s" : ""}`;
        } else {
          return `${diffSeconds} sec${diffSeconds !== 1 ? "s" : ""}`;
        }
      };

      return (
        <div className="min-w-0" aria-label="Timeline time ruler">
          <svg
            ref={svgRef}
            width={width}
            height={40}
            className="zoomable block overflow-hidden rounded-md text-foreground"
            style={{ cursor: "crosshair" }}
          >
            {/* Selection area background - indicates where users can drag to select */}
            <rect
              x={0}
              y={0}
              width={width}
              height={40}
              fill="rgba(128, 128, 128, 0.1)"
              stroke="rgba(128, 128, 128, 0.3)"
              strokeWidth={1}
              rx={6}
              ry={6}
              pointerEvents="none"
            />
            {selectionRect && (
              <>
                {/* Dim overlay for non-selected area BEFORE selection */}
                <rect
                  x={0}
                  y={0}
                  width={Math.max(0, Math.min(width, selectionRect.left))}
                  height={40}
                  fill="rgba(255, 255, 255, 0.5)"
                  pointerEvents="none"
                />
                {/* Dim overlay for non-selected area AFTER selection */}
                <rect
                  x={selectionRect.left + selectionRect.width}
                  y={0}
                  width={Math.max(
                    0,
                    width - (selectionRect.left + selectionRect.width),
                  )}
                  height={40}
                  fill="rgba(255, 255, 255, 0.5)"
                  pointerEvents="none"
                />
                <rect
                  x={selectionRect.left}
                  y={0}
                  width={selectionRect.width}
                  height={40}
                  fill="transparent"
                  stroke="rgba(59, 130, 246, 0.5)"
                  strokeWidth={1}
                  pointerEvents="none"
                />

                {/* Visual Handles */}
                <rect
                  x={selectionRect.left - 2}
                  y={0}
                  width={4}
                  height={40}
                  fill="rgba(59, 130, 246, 0.8)"
                  stroke="rgba(59, 130, 246, 1)"
                  strokeWidth={1}
                  pointerEvents="none"
                />
                <rect
                  x={selectionRect.left + selectionRect.width - 2}
                  y={0}
                  width={4}
                  height={40}
                  fill="rgba(59, 130, 246, 0.8)"
                  stroke="rgba(59, 130, 246, 1)"
                  strokeWidth={1}
                  pointerEvents="none"
                />
              </>
            )}
            <TimelineAxis
              scale={scale}
              transform={transform}
              width={width}
              formatter={options.formatter}
              resolveTimeZone={resolveTimeZone}
            />
            {selectionRect && (
              <>
                {/* Interactive Hit Areas */}
                <rect
                  className="selection-handle selection-handle-left"
                  x={selectionRect.left - 5}
                  y={0}
                  width={10}
                  height={40}
                  fill="transparent"
                  style={{ cursor: "ew-resize" }}
                  pointerEvents="all"
                />
                <rect
                  className="selection-handle selection-handle-right"
                  x={selectionRect.left + selectionRect.width - 5}
                  y={0}
                  width={10}
                  height={40}
                  fill="transparent"
                  style={{ cursor: "ew-resize" }}
                  pointerEvents="all"
                />
              </>
            )}
          </svg>
          {selectionRect && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-b-md bg-blue-500/10 px-2 py-1.5 text-xs tabular-nums">
              <span>
                <span className="text-muted-foreground">From</span>{" "}
                {formatSelectionDate(selectionRect.start)}
              </span>
              <span>
                <span className="text-muted-foreground">To</span>{" "}
                {formatSelectionDate(selectionRect.end)}
              </span>
              <span className="font-medium">
                {formatDuration(selectionRect.start, selectionRect.end)}
              </span>
            </div>
          )}
        </div>
      );
    },
  } as Layer;
};

interface TimelineAxisProps extends LayerComponentProps {
  formatter: Formatter;
  resolveTimeZone: (date: Date) => string;
}

const TimelineAxis = ({
  scale,
  transform,
  width,
  formatter = gregorianFormatter,
  resolveTimeZone,
}: TimelineAxisProps) => {
  const labels = useMemo(
    () => formatter(scale, transform, width, { resolveTimeZone }),
    [
      scale,
      transform,
      width,
      formatter,
      resolveTimeZone,
    ],
  );

  const ticks = useMemo(() => rulerTicks(scale, transform, width, labels), [
    scale,
    transform,
    width,
    labels,
  ]);
  const layout = useMemo(() => layoutRulerLabels(labels, width), [
    labels,
    width,
  ]);

  return (
    <g style={{ pointerEvents: "none" }}>
      <line
        x1={0}
        x2={width}
        y1={39}
        y2={39}
        stroke="currentColor"
        opacity={0.3}
      />
      {ticks.map(({ value, xOffset, major }) => (
        <line
          key={value.getTime()}
          data-ruler-tick={major ? "major" : "minor"}
          x1={xOffset}
          x2={xOffset}
          y1={major ? 29 : 35}
          y2={39}
          stroke="currentColor"
          strokeWidth={major ? 1.5 : 1}
          opacity={major ? 0.65 : 0.3}
        />
      ))}
      {layout.map(({ value, left, labelWidth, xOffset, segments }) => (
        <foreignObject
          key={value.getTime()}
          x={left}
          y={0}
          width={labelWidth}
          height={28}
        >
          <div
            data-ruler-label
            className="overflow-hidden text-xs leading-[14px] tabular-nums"
            style={{
              textAlign: xOffset < labelWidth / 2
                ? "left"
                : xOffset > width - labelWidth / 2
                ? "right"
                : "center",
            }}
          >
            <div className="truncate font-medium">{segments[0]}</div>
            <div className="truncate text-[10px] text-muted-foreground">
              {segments.slice(1).reverse().join(" · ")}
            </div>
          </div>
        </foreignObject>
      ))}
    </g>
  );
};
