import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { useTimelineRange } from "../stores/timelineRange.ts";
import {
  clampTimelineRange,
  MAX_TIMELINE_DATE,
  MAX_TIMELINE_SPAN,
  MIN_TIMELINE_DATE,
  MIN_TIMELINE_SPAN,
  normalizeTimelineRange,
  paddedTimelineBounds,
  timelineBaseScale,
  type TimelineBounds,
  timelineTransform,
} from "@/lib/timelineViewport";

export function useTimeline(dataBounds?: TimelineBounds) {
  const bounds = useMemo(() => paddedTimelineBounds(dataBounds), [dataBounds]);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const { start, end, setRange } = useTimelineRange();
  // Keep the reference domain fixed: never apply a transform to an already zoomed range.
  const base = useRef(normalizeTimelineRange(start, end));
  const timeScale = useMemo(
    () => timelineBaseScale(base.current.start, base.current.end, width),
    [width],
  );
  const transform = useMemo(
    () => timelineTransform(timeScale, width, start, end),
    [timeScale, width, start, end],
  );
  const currentTransform = useRef(transform);
  currentTransform.current = transform;
  const pending = useRef<ReturnType<typeof normalizeTimelineRange> | null>(
    null,
  );
  const frame = useRef<number | null>(null);
  const cancelPending = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    pending.current = null;
  }, []);

  useEffect(() => {
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  const zoomBehavior = useMemo(() => {
    const baseSpan = +base.current.end - +base.current.start;
    return d3.zoom<SVGSVGElement, unknown>()
      .extent([[0, 0], [width, 100]])
      .scaleExtent([
        baseSpan /
        Math.min(
          MAX_TIMELINE_SPAN,
          bounds ? +bounds.end - +bounds.start : MAX_TIMELINE_SPAN,
        ),
        baseSpan / MIN_TIMELINE_SPAN,
      ])
      .translateExtent([[
        timeScale(bounds?.start ?? new Date(MIN_TIMELINE_DATE)),
        -Infinity,
      ], [
        timeScale(bounds?.end ?? new Date(MAX_TIMELINE_DATE)),
        Infinity,
      ]])
      .touchable(() => true)
      .filter((event) => event.type !== "dblclick" && !event.button)
      .on("zoom", (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        const [s, e] = event.transform.rescaleX(timeScale).domain();
        if (!Number.isFinite(+s) || !Number.isFinite(+e)) return;
        pending.current = clampTimelineRange(s, e, bounds);
        const t = timelineTransform(
          timeScale,
          width,
          pending.current.start,
          pending.current.end,
        );
        currentTransform.current = t;
        d3.select(container).selectAll<SVGSVGElement, unknown>(
          ".zoomable, .zoomed",
        ).property("__zoom", t);
        if (frame.current === null) {
          frame.current = requestAnimationFrame(() => {
            frame.current = null;
            if (pending.current) {
              setRange(pending.current.start, pending.current.end);
            }
            pending.current = null;
          });
        }
      });
  }, [container, timeScale, width, setRange, bounds]);

  useEffect(() => {
    if (!container) return;
    const attached = new Set<SVGSVGElement>();
    const attach = () => {
      container.querySelectorAll<SVGSVGElement>(".zoomable").forEach((node) => {
        if (attached.has(node)) return;
        attached.add(node);
        d3.select(node).call(zoomBehavior).property(
          "__zoom",
          currentTransform.current,
        );
      });
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      cancelPending();
      observer.disconnect();
      for (const node of attached) d3.select(node).on(".zoom", null);
    };
  }, [container, zoomBehavior, cancelPending]);

  useEffect(() => {
    if (!container) return;
    d3.select(container).selectAll<SVGSVGElement, unknown>(".zoomable, .zoomed")
      .property("__zoom", transform);
  }, [container, transform]);

  const zoomTo = useCallback((newStart: Date, newEnd: Date) => {
    cancelPending();
    const range = clampTimelineRange(newStart, newEnd, bounds);
    setRange(range.start, range.end);
  }, [setRange, cancelPending, bounds]);

  useEffect(() => {
    const range = clampTimelineRange(start, end, bounds);
    if (+range.start !== +start || +range.end !== +end) {
      zoomTo(range.start, range.end);
    }
  }, [start, end, bounds, zoomTo]);

  useEffect(() => {
    if (!container) return;
    // Forward wheel gestures over gaps and labels to the ruler's D3 handler.
    const onWheel = (event: WheelEvent) => {
      if (
        (event.target as Element).closest("input,select,button,[role=dialog]")
      ) return;
      event.preventDefault();
      if ((event.target as Element).closest(".zoomable")) return;
      const ruler = container.querySelector<SVGSVGElement>(".zoomable");
      if (!ruler) return;
      event.preventDefault();
      ruler.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: event.deltaY,
          deltaX: event.deltaX,
          deltaMode: event.deltaMode,
          clientX: event.clientX,
          clientY: event.clientY,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          bubbles: false,
          cancelable: true,
        }),
      );
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [container]);

  return {
    containerRef: setContainer,
    dimensions: { width, height: 100 },
    transform,
    timeScale,
    width,
    zoomTo,
  };
}
