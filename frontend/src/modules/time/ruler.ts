import type { ScaleTime, ZoomTransform } from "d3";
import type { Label } from "./formatters/types";

/** Calendar ticks come from the same transformed scale as the data tracks. */
export function rulerTicks(
  scale: ScaleTime<number, number>,
  transform: ZoomTransform,
  width: number,
  labels: Label[],
) {
  if (width <= 0) return [];
  const visibleScale = transform.rescaleX(scale);
  const majorTimes = new Set(labels.map(({ value }) => value.getTime()));
  const values = new Map(
    visibleScale.ticks(Math.max(2, Math.floor(width / 24)))
      .map((value) => [value.getTime(), value]),
  );
  for (const { value } of labels) values.set(value.getTime(), value);
  return [...values.values()].map((value) => ({
    value,
    xOffset: visibleScale(value),
    major: majorTimes.has(value.getTime()),
  })).filter(({ xOffset }) => xOffset >= 0 && xOffset <= width)
    .sort((a, b) => a.xOffset - b.xOffset);
}

/** Clamp edge labels and skip collisions, leaving their tick marks visible. */
export function layoutRulerLabels(labels: Label[], width: number) {
  if (width <= 0) return [];
  let previousRight = -8;
  return labels.filter(({ xOffset }) => xOffset >= 0 && xOffset <= width)
    .flatMap((label) => {
      const textLength = Math.max(
        String(label.segments[0] ?? "").length,
        label.segments.slice(1).join(" · ").length * 0.85,
      );
      const labelWidth = Math.min(
        width,
        Math.max(48, Math.min(180, textLength * 7 + 12)),
      );
      const left = Math.max(
        0,
        Math.min(width - labelWidth, label.xOffset - labelWidth / 2),
      );
      if (left < previousRight + 8) return [];
      previousRight = left + labelWidth;
      return [{ ...label, left, labelWidth }];
    });
}
