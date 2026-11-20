import { type ScaleTime, scaleTime, zoomIdentity } from "d3";

export const MIN_TIMELINE_SPAN = 1_000;
// Stay below the object-density limit of 2,000 weekly buckets, including padding.
export const MAX_TIMELINE_SPAN = 30 * 365.25 * 86_400_000;
export const MIN_TIMELINE_DATE = Date.parse("0001-01-01T00:00:00Z");
export const MAX_TIMELINE_DATE = Date.parse("9999-12-31T00:00:00Z");

export type TimelineBounds = { start: Date; end: Date };

export function paddedTimelineBounds(bounds?: TimelineBounds) {
  if (
    !bounds || !Number.isFinite(+bounds.start) ||
    !Number.isFinite(+bounds.end) || +bounds.end < +bounds.start
  ) return undefined;
  const padding = Math.max(
    86_400_000,
    Math.min(7 * 86_400_000, (+bounds.end - +bounds.start) * 0.05),
  );
  return {
    start: new Date(+bounds.start - padding),
    end: new Date(+bounds.end + padding),
  };
}

export function clampTimelineRange(
  start: Date,
  end: Date,
  bounds?: TimelineBounds,
) {
  const safe = normalizeTimelineRange(start, end);
  if (!bounds) return safe;
  const span = Math.min(+safe.end - +safe.start, +bounds.end - +bounds.start);
  const left = Math.max(
    +bounds.start,
    Math.min(+bounds.end - span, +safe.start),
  );
  return { start: new Date(left), end: new Date(left + span) };
}

export function defaultTimelineRange() {
  const end = new Date();
  return { start: new Date(+end - 30 * 86_400_000), end };
}

export function normalizeTimelineRange(start: Date, end: Date) {
  const s = +start;
  const e = +end;
  if (
    !Number.isFinite(s) || !Number.isFinite(e) || e <= s ||
    s < MIN_TIMELINE_DATE || e > MAX_TIMELINE_DATE
  ) return defaultTimelineRange();
  const span = Math.max(MIN_TIMELINE_SPAN, Math.min(MAX_TIMELINE_SPAN, e - s));
  const left = Math.max(
    MIN_TIMELINE_DATE,
    Math.min(MAX_TIMELINE_DATE - span, s + (e - s - span) / 2),
  );
  return { start: new Date(left), end: new Date(left + span) };
}

export function timelineTransform(
  scale: ScaleTime<number, number>,
  width: number,
  start: Date,
  end: Date,
) {
  const k = width / (scale(end) - scale(start));
  return zoomIdentity.translate(-scale(start) * k, 0).scale(k);
}

export function timelineBaseScale(start: Date, end: Date, width: number) {
  return scaleTime().domain([start, end]).range([0, Math.max(1, width)]);
}
