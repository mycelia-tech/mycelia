import * as d3 from "d3";
import React from "react";
import { Label, Tick } from "./types.ts";
import { getShortTimeZoneName, getZonedDateParts } from "@/lib/timeZones";

const day = 1000 * 60 * 60 * 24;

const checkAllJanFirst = (
  ticks: Tick[],
  resolveTimeZone: (date: Date) => string,
): boolean => {
  return ticks.length > 0 &&
    ticks.every(({ value }) => {
      const parts = getZonedDateParts(value, resolveTimeZone(value));
      return parts.month === 1 && parts.day === 1 && parts.hour === 0 &&
        parts.minute === 0 && parts.second === 0 &&
        value.getMilliseconds() === 0;
    });
};

const checkHasTime = (
  ticks: Tick[],
  resolveTimeZone: (date: Date) => string,
): boolean => {
  return ticks.some(({ value }) => {
    const parts = getZonedDateParts(value, resolveTimeZone(value));
    return parts.hour !== 0 || parts.minute !== 0 || parts.second !== 0;
  });
};

const checkHasWeekdays = (ticks: Tick[]): boolean => {
  if (ticks.length < 2) return false;
  const [first, last] = [ticks[0].value, ticks[ticks.length - 1].value];
  return last.getTime() - first.getTime() < 30 * day;
};

const checkHasSeconds = (
  ticks: Tick[],
  resolveTimeZone: (date: Date) => string,
): boolean => {
  return ticks.some(({ value }) =>
    getZonedDateParts(value, resolveTimeZone(value)).second !== 0
  );
};

const checkHasMilliseconds = (ticks: Tick[]): boolean => {
  return ticks.some(({ value }) => value.getMilliseconds() !== 0);
};

const formatTime = (
  date: Date,
  hasSeconds: boolean,
  hasMilliseconds: boolean,
  timeZone: string,
): string => {
  if (hasMilliseconds) {
    return date.toLocaleTimeString([], {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }) + `.${date.getMilliseconds().toString().padStart(3, "0")}`;
  }

  return hasSeconds
    ? date.toLocaleTimeString([], {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    : date.toLocaleTimeString([], {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
};

export const formatLabel = (
  date: Date,
  options?: {
    allJanFirst?: boolean;
    hasTime?: boolean;
    hasWeekdays?: boolean;
    hasSeconds?: boolean;
    hasMilliseconds?: boolean;
  },
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
): React.ReactNode[] => {
  const parts = getZonedDateParts(date, timeZone);
  const year = parts.year.toString();
  const defaults = {
    allJanFirst: false,
    hasTime: true,
    hasWeekdays: true,
    hasSeconds: true,
    hasMilliseconds: false,
  };

  const { allJanFirst, hasTime, hasWeekdays, hasSeconds, hasMilliseconds } = {
    ...defaults,
    ...options,
  };

  if (allJanFirst) {
    return [year];
  }

  const month = date.toLocaleDateString([], { month: "short", timeZone });
  const day = parts.day;
  const weekday = date.toLocaleDateString([], { weekday: "short", timeZone });

  return [
    hasTime ? formatTime(date, hasSeconds, hasMilliseconds, timeZone) : null,
    hasTime ? getShortTimeZoneName(date, timeZone) : null,
    `${month} ${day}`,
    hasWeekdays ? weekday : null,
    year,
  ].filter(Boolean) as React.ReactNode[];
};

const generateGregorianLabels = (
  scale: d3.ScaleTime<number, number>,
  transform: d3.ZoomTransform,
  width: number,
  context?: { resolveTimeZone?: (date: Date) => string },
): Label[] => {
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";
  const resolveTimeZone = context?.resolveTimeZone ?? (() => browserTimeZone);
  const newScale = transform.rescaleX(scale);
  const tickCount = Math.max(2, Math.ceil(width / 160));
  let tickValues = newScale.ticks(tickCount);
  // D3 may pick a month interval just outside a short/narrow visible range.
  if (tickValues.length < 2) tickValues = newScale.ticks(tickCount * 2);
  const ticks = tickValues.map((tick) => ({
    value: tick,
    xOffset: newScale(tick),
  }));

  const allJanFirst = checkAllJanFirst(ticks, resolveTimeZone);
  const hasTime = checkHasTime(ticks, resolveTimeZone);
  const hasWeekdays = checkHasWeekdays(ticks);
  const hasSeconds = checkHasSeconds(ticks, resolveTimeZone);
  const hasMilliseconds = checkHasMilliseconds(ticks);

  let prev: React.ReactNode[] | null = null;
  return ticks.map(({ value, xOffset }) => {
    const timeZone = resolveTimeZone(value);
    const fullSegments = formatLabel(
      value,
      { allJanFirst, hasTime, hasWeekdays, hasSeconds, hasMilliseconds },
      timeZone,
    );
    const result = {
      value,
      xOffset,
      segments: !prev
        ? fullSegments
        : fullSegments.filter((segment, i) => i === 0 || segment !== prev![i]),
    };
    prev = fullSegments;
    return result;
  });
};

export default generateGregorianLabels;
