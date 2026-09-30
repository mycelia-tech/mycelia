import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";
import { CalendarRange, Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  calendarDateInTimeZone,
  type DatePickerPrecision,
  type DateRangeValue,
  formatPickerDateTime,
  formatPickerDuration,
  formatPickerRange,
  isValidPickerDate,
  pickerTimeZoneLabel,
  replaceZonedCalendarDate,
  replaceZonedTime,
  zonedTimeInputValue,
} from "@/lib/datePicker";
import { resolveDefaultTimeZone } from "@/lib/timeZones";
import { useSettingsStore } from "@/stores/settingsStore";
import { useHistogramItems } from "@/modules/histogram/useHistogramItems";
import { cn } from "@/lib/utils";
import { snapAudioRange } from "@/lib/audioRangeSelection";

type DateRangePickerProps = {
  value?: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  allowOpenEnd?: boolean;
  precision?: DatePickerPrecision;
  timeZone?: string;
  minDate?: Date;
  maxDate?: Date;
  maxDurationMs?: number;
  showAudioTimeline?: boolean;
  className?: string;
};

type ActiveBoundary = "start" | "end";

function useDesktopCalendar(): boolean {
  const [desktop, setDesktop] = useState(() =>
    typeof window === "undefined" ||
    window.matchMedia("(min-width: 640px)").matches
  );

  useEffect(() => {
    const query = window.matchMedia("(min-width: 640px)");
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return desktop;
}

function AudioRangeTimeline({
  domain,
  value,
  onChange,
  precision,
  timeZone,
}: {
  domain: { start: Date; end: Date };
  value: { start: Date; end: Date };
  onChange: (value: { start: Date; end: Date }) => void;
  precision: Exclude<DatePickerPrecision, "date">;
  timeZone: string;
}) {
  const { items } = useHistogramItems(domain.start, domain.end);
  const [sliderValue, setSliderValue] = useState([
    value.start.getTime(),
    value.end.getTime(),
  ]);
  const domainStart = domain.start.getTime();
  const domainEnd = domain.end.getTime();
  const domainDuration = Math.max(1, domainEnd - domainStart);

  useEffect(() => {
    setSliderValue([value.start.getTime(), value.end.getTime()]);
  }, [value.start, value.end]);

  const available = useMemo(
    () =>
      items.filter((item) =>
        item.start.getTime() < domainEnd && item.end.getTime() > domainStart &&
        (item.totals.audio_chunks?.count ?? 0) > 0
      ),
    [items, domainEnd, domainStart],
  );
  const maxCount = Math.max(
    1,
    ...available.map((item) => item.totals.audio_chunks?.count ?? 0),
  );

  const commit = (next: number[]) => {
    const snapped = snapAudioRange(
      [next[0], next[1]],
      [domainStart, domainEnd],
      available.map((item) => ({
        start: item.start.getTime(),
        end: item.end.getTime(),
      })),
      precision === "second" ? 1_000 : 60_000,
      [value.start.getTime(), value.end.getTime()],
    );
    setSliderValue(snapped);
    onChange({ start: new Date(snapped[0]), end: new Date(snapped[1]) });
  };

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-sm">Timeline range</Label>
        <span className="text-xs text-muted-foreground">
          {available.length > 0
            ? "Drag an edge; it snaps to available audio"
            : "Drag an edge to refine the range"}
        </span>
      </div>
      <div className="relative h-16 overflow-hidden rounded-md bg-muted/40 px-2 pt-2">
        <div className="absolute inset-x-2 bottom-5 top-2">
          {available.map((item) => {
            const start = Math.max(item.start.getTime(), domainStart);
            const end = Math.min(item.end.getTime(), domainEnd);
            const count = item.totals.audio_chunks?.count ?? 0;
            return (
              <span
                key={item.id}
                className="absolute bottom-0 min-w-px rounded-t-sm bg-primary/55"
                style={{
                  left: `${((start - domainStart) / domainDuration) * 100}%`,
                  width: `${
                    Math.max(0.2, ((end - start) / domainDuration) * 100)
                  }%`,
                  height: `${Math.max(10, (count / maxCount) * 100)}%`,
                }}
              />
            );
          })}
          {available.length === 0 && (
            <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              Audio density is not available for this period
            </span>
          )}
        </div>
        <Slider
          className="absolute inset-x-2 bottom-2 w-auto"
          min={domainStart}
          max={domainEnd}
          step={precision === "second" ? 1_000 : 60_000}
          minStepsBetweenThumbs={1}
          value={sliderValue}
          onValueChange={setSliderValue}
          onValueCommit={commit}
          thumbLabels={["Range start", "Range end"]}
          aria-label="Selected audio range"
        />
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>
          {formatPickerRange({ start: domain.start }, timeZone, precision)}
        </span>
        <span>
          {formatPickerRange({ start: domain.end }, timeZone, precision)}
        </span>
      </div>
    </div>
  );
}

export function DateRangePicker({
  value,
  onChange,
  label,
  placeholder = "Choose a range",
  disabled = false,
  allowOpenEnd = false,
  precision = "minute",
  timeZone: requestedTimeZone,
  minDate,
  maxDate,
  maxDurationMs,
  showAudioTimeline = false,
  className,
}: DateRangePickerProps) {
  const defaultTimeZone = useSettingsStore((state) => state.defaultTimeZone);
  const timeZone = requestedTimeZone ?? resolveDefaultTimeZone(defaultTimeZone);
  const prepareDraft = (next: DateRangeValue): DateRangeValue => {
    if (precision !== "date") return next;
    const dayOnly = (date: Date) =>
      replaceZonedCalendarDate(
        date,
        calendarDateInTimeZone(date, timeZone),
        timeZone,
        "date",
      );
    return {
      start: dayOnly(next.start),
      end: next.end ? dayOnly(next.end) : undefined,
    };
  };
  const [open, setOpen] = useState(false);
  const [activeBoundary, setActiveBoundary] = useState<ActiveBoundary>("start");
  const [month, setMonth] = useState(() =>
    calendarDateInTimeZone(value?.start ?? new Date(), timeZone)
  );
  const [draft, setDraft] = useState<DateRangeValue>(() =>
    prepareDraft(
      value ?? {
        start: new Date(Date.now() - 86_400_000),
        end: new Date(),
      },
    )
  );
  const [timelineDomain, setTimelineDomain] = useState<
    {
      start: Date;
      end: Date;
    } | null
  >(value?.end ? { start: value.start, end: value.end } : null);
  const desktopCalendar = useDesktopCalendar();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open && value) setDraft(value);
  }, [open, value]);

  useEffect(() => {
    if (open && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [open]);

  const selected: DateRange = {
    from: isValidPickerDate(draft.start)
      ? calendarDateInTimeZone(draft.start, timeZone)
      : undefined,
    to: isValidPickerDate(draft.end)
      ? calendarDateInTimeZone(draft.end, timeZone)
      : undefined,
  };
  const duration = value ? formatPickerDuration(value, precision) : null;
  const calendarMin = minDate
    ? calendarDateInTimeZone(minDate, timeZone)
    : undefined;
  const calendarMax = maxDate
    ? calendarDateInTimeZone(maxDate, timeZone)
    : undefined;
  const draftError = (() => {
    if (!isValidPickerDate(draft.start)) return "Choose a start date.";
    for (const date of [draft.start, draft.end]) {
      if (!isValidPickerDate(date)) continue;
      const comparable = precision === "date"
        ? calendarDateInTimeZone(date, timeZone)
        : date;
      if (
        minDate && comparable < (precision === "date" ? calendarMin! : minDate)
      ) {
        return `Choose a date${
          precision === "date" ? "" : " and time"
        } on or after ${formatPickerDateTime(minDate, timeZone, precision)}.`;
      }
      if (
        maxDate && comparable > (precision === "date" ? calendarMax! : maxDate)
      ) {
        return `Choose a date${
          precision === "date" ? "" : " and time"
        } on or before ${formatPickerDateTime(maxDate, timeZone, precision)}.`;
      }
    }
    if (!draft.end) return allowOpenEnd ? null : "Choose the finish date.";
    if (!isValidPickerDate(draft.end)) return "Choose a valid finish date.";
    const difference = draft.end.getTime() - draft.start.getTime();
    if (precision === "date" ? difference < 0 : difference <= 0) {
      return "The finish must be after the start.";
    }
    if (maxDurationMs != null && difference > maxDurationMs) {
      return `This range is longer than the allowed ${
        Math.round(maxDurationMs / 3_600_000)
      } hours.`;
    }
    return null;
  })();

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      const nextDraft = prepareDraft(
        value ?? {
          start: new Date(Date.now() - 86_400_000),
          end: new Date(),
        },
      );
      setDraft(nextDraft);
      setMonth(calendarDateInTimeZone(nextDraft.start, timeZone));
      setTimelineDomain(
        nextDraft.end ? { start: nextDraft.start, end: nextDraft.end } : null,
      );
      setActiveBoundary("start");
    }
    setOpen(nextOpen);
  };

  const activateBoundary = (boundary: ActiveBoundary) => {
    setActiveBoundary(boundary);
    const date = boundary === "start" ? draft.start : draft.end ?? draft.start;
    setMonth(calendarDateInTimeZone(date, timeZone));
  };

  const updateExactTime = (boundary: ActiveBoundary, next: Date) => {
    const nextDraft = { ...draft, [boundary]: next };
    setDraft(nextDraft);
    if (nextDraft.end && nextDraft.end > nextDraft.start) {
      setTimelineDomain({ start: nextDraft.start, end: nextDraft.end });
    }
  };

  const handleCalendarDayClick = (calendarDate: Date) => {
    const boundaryValue = activeBoundary === "start"
      ? draft.start
      : draft.end ?? draft.start;
    const nextBoundary = replaceZonedCalendarDate(
      boundaryValue,
      calendarDate,
      timeZone,
      precision,
    );
    const nextDraft = activeBoundary === "start"
      ? {
        start: nextBoundary,
        end: draft.end && (precision === "date"
            ? draft.end.getTime() >= nextBoundary.getTime()
            : draft.end.getTime() > nextBoundary.getTime())
          ? draft.end
          : undefined,
      }
      : { ...draft, end: nextBoundary };
    setDraft(nextDraft);
    if (
      nextDraft.end &&
      (precision === "date"
        ? nextDraft.end.getTime() >= nextDraft.start.getTime()
        : nextDraft.end.getTime() > nextDraft.start.getTime())
    ) {
      setTimelineDomain({ start: nextDraft.start, end: nextDraft.end });
    }
    if (activeBoundary === "start") setActiveBoundary("end");
  };

  const apply = () => {
    if (draftError) return;
    onChange(draft);
    setOpen(false);
  };

  const displayValue = value && isValidPickerDate(value.start)
    ? formatPickerRange(value, timeZone, precision)
    : placeholder;

  return (
    <div className={cn("space-y-2", className)}>
      {label && <Label htmlFor={`${id}-trigger`}>{label}</Label>}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger asChild>
          <Button
            id={`${id}-trigger`}
            type="button"
            variant="outline"
            disabled={disabled}
            className="h-auto min-h-10 w-full justify-start gap-2 whitespace-normal px-3 py-2 text-left font-normal"
          >
            <CalendarRange className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">{displayValue}</span>
            {duration && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {duration}
              </span>
            )}
          </Button>
        </DialogTrigger>
        <DialogContent
          showCloseButton={false}
          className="flex !max-h-[calc(100dvh-2rem)] !w-[calc(100%-2rem)] !max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:!max-w-[48rem]"
        >
          <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
            <DialogTitle>{label ?? "Choose date range"}</DialogTitle>
            <DialogDescription>
              Select Start or End, then choose its{" "}
              {precision === "date" ? "date." : "date and time."}
            </DialogDescription>
          </DialogHeader>

          <div
            ref={scrollContainerRef}
            data-slot="date-range-picker-scroll"
            className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                aria-pressed={activeBoundary === "start"}
                className={cn(
                  "rounded-lg border p-3 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  activeBoundary === "start"
                    ? "border-primary bg-primary/15 ring-1 ring-primary"
                    : "border-border bg-card",
                )}
                onClick={() => activateBoundary("start")}
              >
                <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Start
                </span>
                <span className="mt-1 block text-sm font-medium text-foreground">
                  {formatPickerDateTime(draft.start, timeZone, precision)}
                </span>
              </button>
              <button
                type="button"
                aria-pressed={activeBoundary === "end"}
                className={cn(
                  "rounded-lg border p-3 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  activeBoundary === "end"
                    ? "border-primary bg-primary/15 ring-1 ring-primary"
                    : "border-border bg-card",
                )}
                onClick={() => activateBoundary("end")}
              >
                <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  End
                </span>
                <span className="mt-1 block text-sm font-medium text-foreground">
                  {draft.end
                    ? formatPickerDateTime(draft.end, timeZone, precision)
                    : "Choose finish"}
                </span>
              </button>
            </div>

            <Calendar
              mode="range"
              selected={selected}
              // onSelect makes DayPicker controlled; edits target the active boundary below.
              onSelect={() => {}}
              onDayClick={handleCalendarDayClick}
              numberOfMonths={desktopCalendar ? 2 : 1}
              captionLayout="dropdown"
              month={month}
              onMonthChange={setMonth}
              startMonth={calendarMin ?? new Date(1900, 0, 1)}
              endMonth={calendarMax ??
                new Date(new Date().getFullYear() + 20, 11, 31)}
              disabled={calendarMin && calendarMax
                ? [{ before: calendarMin }, { after: calendarMax }]
                : calendarMin
                ? { before: calendarMin }
                : calendarMax
                ? { after: calendarMax }
                : undefined}
              classNames={{
                months: desktopCalendar
                  ? "relative flex flex-row gap-4"
                  : "relative flex flex-col gap-4",
                month: "flex min-w-0 flex-1 flex-col gap-4",
              }}
              modifiers={{
                activeBoundary: activeBoundary === "start"
                  ? selected.from
                  : selected.to,
              }}
              modifiersClassNames={{
                activeBoundary:
                  "relative z-10 rounded-md ring-2 ring-primary ring-offset-1 ring-offset-background",
              }}
              className="mx-auto max-w-full [--cell-size:clamp(1.75rem,calc((100vw-6rem)/7),2.25rem)]"
            />

            {precision !== "date" && (
              <div className="space-y-2 border-t pt-3">
                <Label>Exact time</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label
                    className={cn(
                      "grid gap-1 rounded-md border p-2 text-xs text-muted-foreground",
                      activeBoundary === "start"
                        ? "border-primary bg-primary/10"
                        : "border-border",
                    )}
                    onFocus={() => setActiveBoundary("start")}
                  >
                    Start
                    <Input
                      type="time"
                      step={precision === "second" ? 1 : 60}
                      value={zonedTimeInputValue(
                        draft.start,
                        timeZone,
                        precision,
                      )}
                      onChange={(event) => {
                        const next = replaceZonedTime(
                          draft.start,
                          event.target.value,
                          timeZone,
                          precision,
                        );
                        if (next) {
                          updateExactTime("start", next);
                        }
                      }}
                    />
                  </label>
                  <label
                    className={cn(
                      "grid gap-1 rounded-md border p-2 text-xs text-muted-foreground",
                      activeBoundary === "end"
                        ? "border-primary bg-primary/10"
                        : "border-border",
                    )}
                    onFocus={() => setActiveBoundary("end")}
                  >
                    End
                    <Input
                      type="time"
                      step={precision === "second" ? 1 : 60}
                      disabled={!draft.end}
                      value={draft.end
                        ? zonedTimeInputValue(draft.end, timeZone, precision)
                        : ""}
                      onChange={(event) => {
                        if (!draft.end) {
                          return;
                        }
                        const next = replaceZonedTime(
                          draft.end,
                          event.target.value,
                          timeZone,
                          precision,
                        );
                        if (next) {
                          updateExactTime("end", next);
                        }
                      }}
                    />
                  </label>
                </div>
              </div>
            )}

            {showAudioTimeline && precision !== "date" && draft.end &&
              isValidPickerDate(draft.start) && isValidPickerDate(draft.end) &&
              draft.end > draft.start &&
              timelineDomain && (
              <AudioRangeTimeline
                domain={timelineDomain}
                value={{ start: draft.start, end: draft.end }}
                onChange={(next) => setDraft(next)}
                precision={precision}
                timeZone={timeZone}
              />
            )}
          </div>

          <div
            data-slot="date-range-picker-footer"
            className="shrink-0 space-y-2 border-t bg-background px-4 py-3"
          >
            {draftError && (
              <p role="alert" className="text-xs text-destructive">
                {draftError}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {pickerTimeZoneLabel(draft.start, timeZone)}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {allowOpenEnd && draft.end && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraft((current) => ({ ...current, end: undefined }));
                      setActiveBoundary("end");
                    }}
                  >
                    <X className="mr-1 h-3.5 w-3.5" />
                    No finish
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={apply}
                  disabled={Boolean(draftError)}
                >
                  <Check className="mr-1 h-3.5 w-3.5" />
                  Apply range
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
