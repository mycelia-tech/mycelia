import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTimelineTimeZone } from "@/hooks/useTimelineTimeZone";
import { getZonedDateParts, zonedDateTimeToUtc } from "@/lib/timeZones";

export function calendarDateRange(
  value: string,
  unit: "day" | "week",
  timeZone: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(`${value}T12:00:00Z`);
  if (
    !Number.isFinite(+date) || date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) return undefined;
  if (unit === "week") date.setUTCDate(day - (date.getUTCDay() + 6) % 7);
  const asUtc = () =>
    zonedDateTimeToUtc({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    }, timeZone);
  const start = asUtc();
  date.setUTCDate(date.getUTCDate() + (unit === "week" ? 7 : 1));
  return { start, end: asUtc() };
}

export function TimelineDateJump(
  { center, onJump }: {
    center: Date;
    onJump: (start: Date, end: Date) => void;
  },
) {
  const { resolveTimeZone } = useTimelineTimeZone();
  const [date, setDate] = useState(() => {
    const p = getZonedDateParts(center, resolveTimeZone(center));
    return `${p.year}-${String(p.month).padStart(2, "0")}-${
      String(p.day).padStart(2, "0")
    }`;
  });
  const zone = resolveTimeZone(new Date(`${date || "2000-01-01"}T12:00:00Z`));
  const jump = (unit: "day" | "week") => {
    const range = calendarDateRange(date, unit, zone);
    if (range) onJump(range.start, range.end);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <label
        htmlFor="timeline-jump-date"
        className="text-xs text-muted-foreground"
      >
        Go to date
      </label>
      <input
        id="timeline-jump-date"
        type="date"
        value={date}
        onChange={(event) => setDate(event.target.value)}
        onInput={(event) => setDate(event.currentTarget.value)}
        className="h-8 max-w-full rounded-md border bg-background px-2 text-xs"
      />
      <Button
        variant="outline"
        size="sm"
        className="h-8"
        disabled={!calendarDateRange(date, "day", zone)}
        onClick={() => jump("day")}
      >
        Day
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-8"
        disabled={!calendarDateRange(date, "week", zone)}
        title="Monday–Sunday containing this date"
        onClick={() => jump("week")}
      >
        Week
      </Button>
    </div>
  );
}
