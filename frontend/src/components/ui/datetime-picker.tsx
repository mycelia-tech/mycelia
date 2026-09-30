"use client";

import { useEffect, useId, useState } from "react";
import { CalendarClock, Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  calendarDateInTimeZone,
  type DatePickerPrecision,
  formatPickerDateTime,
  pickerTimeZoneLabel,
  replaceZonedCalendarDate,
  replaceZonedTime,
  zonedTimeInputValue,
} from "@/lib/datePicker";
import { resolveDefaultTimeZone } from "@/lib/timeZones";
import { useSettingsStore } from "@/stores/settingsStore";

interface DateTimePickerProps {
  value?: Date;
  onChange: (value: Date | null) => void;
  placeholder?: string;
  disabled?: boolean;
  nullable?: boolean;
  precision?: DatePickerPrecision;
  timeZone?: string;
}

export function DateTimePicker({
  value,
  onChange,
  placeholder = "Pick a date and time",
  disabled = false,
  nullable = false,
  precision = "minute",
  timeZone: requestedTimeZone,
}: DateTimePickerProps) {
  const defaultTimeZone = useSettingsStore((state) => state.defaultTimeZone);
  const timeZone = requestedTimeZone ?? resolveDefaultTimeZone(defaultTimeZone);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Date | null>(value ?? null);
  const id = useId();

  useEffect(() => {
    if (!open) setDraft(value ?? null);
  }, [open, value]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setDraft(value ?? new Date());
    setOpen(nextOpen);
  };

  const apply = () => {
    if (!draft || !Number.isFinite(draft.getTime())) return;
    onChange(
      precision === "date"
        ? replaceZonedCalendarDate(
          draft,
          calendarDateInTimeZone(draft, timeZone),
          timeZone,
          precision,
        )
        : draft,
    );
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={`${id}-trigger`}
          type="button"
          variant="outline"
          disabled={disabled}
          className="h-auto min-h-10 w-full justify-start gap-2 whitespace-normal px-3 py-2 text-left font-normal"
        >
          <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            {value
              ? formatPickerDateTime(value, timeZone, precision)
              : placeholder}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[var(--radix-popover-content-available-height)] w-[min(calc(100vw-2rem),22rem)] overflow-y-auto p-0"
      >
        <div className="space-y-3 p-3">
          <Calendar
            mode="single"
            selected={draft
              ? calendarDateInTimeZone(draft, timeZone)
              : undefined}
            onSelect={(date) => {
              if (!date) return;
              setDraft((current) =>
                replaceZonedCalendarDate(
                  current ?? new Date(),
                  date,
                  timeZone,
                  precision,
                )
              );
            }}
            defaultMonth={draft
              ? calendarDateInTimeZone(draft, timeZone)
              : undefined}
            captionLayout="dropdown"
            startMonth={new Date(1900, 0, 1)}
            endMonth={new Date(new Date().getFullYear() + 20, 11, 31)}
            className="mx-auto max-w-full [--cell-size:clamp(1.75rem,calc((100vw-6rem)/7),2.25rem)]"
          />
          {precision !== "date" && (
            <label className="grid gap-1 border-t pt-3 text-xs text-muted-foreground">
              Time
              <Input
                type="time"
                step={precision === "second" ? 1 : 60}
                value={draft
                  ? zonedTimeInputValue(draft, timeZone, precision)
                  : ""}
                onChange={(event) => {
                  if (!draft) return;
                  const next = replaceZonedTime(
                    draft,
                    event.target.value,
                    timeZone,
                    precision,
                  );
                  if (next) setDraft(next);
                }}
              />
            </label>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <span className="text-xs text-muted-foreground">
              {pickerTimeZoneLabel(draft ?? new Date(), timeZone)}
            </span>
            <div className="flex items-center gap-2">
              {nullable && value && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onChange(null);
                    setDraft(null);
                    setOpen(false);
                  }}
                >
                  <X className="mr-1 h-3.5 w-3.5" />
                  Clear
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
              <Button type="button" size="sm" onClick={apply} disabled={!draft}>
                <Check className="mr-1 h-3.5 w-3.5" />
                Apply
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
