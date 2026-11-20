import { useEffect, useId, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import type { MapTimelineSummary } from "@/types/location";

const dayMs = 86_400_000;
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const dateTimeWithSecondsFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});
const scaleMarks = [
  { fraction: 0, className: "" },
  { fraction: 0.25, className: "hidden sm:block -translate-x-1/2" },
  { fraction: 0.5, className: "hidden min-[440px]:block -translate-x-1/2" },
  { fraction: 0.75, className: "hidden sm:block -translate-x-1/2" },
  { fraction: 1, className: "-translate-x-full" },
];

function dateLabel(value: number) {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function dateTimeLabel(value: number) {
  return (value % 60_000 === 0 ? dateTimeFormat : dateTimeWithSecondsFormat)
    .format(value);
}

function scaleLabel(value: number, span: number) {
  const date = new Date(value);
  if (span < dayMs) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...(span < 4 * 60_000 ? { second: "2-digit" } : {}),
    });
  }
  if (span >= 365 * dayMs) {
    return date.toLocaleDateString(undefined, {
      month: "short",
      year: "numeric",
    });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(span < 4 * dayMs ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

function durationLabel(ms: number) {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

function rangeDuration(ms: number) {
  const days = Math.floor(ms / dayMs);
  const hours = Math.floor(ms % dayMs / 3_600_000);
  const minutes = Math.floor(ms % 3_600_000 / 60_000);
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes) return `${minutes}m`;
  const seconds = Math.floor(ms / 1000);
  return seconds ? `${seconds}s` : "<1s";
}

function localDateTimeInput(value: number) {
  const date = new Date(value);
  return new Date(value - date.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 16);
}

export function MapTimeNavigator({
  summary,
  start,
  end,
  cursor,
  onCommitRange,
  onSelectTime,
}: {
  summary: MapTimelineSummary | undefined;
  start: Date;
  end: Date;
  cursor?: Date;
  onCommitRange: (start: Date, end: Date) => void;
  onSelectTime: (time: Date) => void;
}) {
  const helpId = useId();
  const editorTitleId = useId();
  const editorErrorId = useId();
  const dataStart = summary
    ? new Date(summary.dataRange.start).getTime()
    : start.getTime();
  const dataEnd = summary
    ? new Date(summary.dataRange.end).getTime()
    : end.getTime();
  const min = Math.min(dataStart, start.getTime());
  const max = Math.max(min + 1, dataEnd, end.getTime());
  const [draft, setDraft] = useState([start.getTime(), end.getTime()]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [editorError, setEditorError] = useState("");
  useEffect(() => setDraft([start.getTime(), end.getTime()]), [
    start.getTime(),
    end.getTime(),
  ]);
  const buckets = summary?.buckets ?? [];
  const maxDwell = Math.max(1, ...buckets.map((b) => b.dwellMs));
  const maxConversations = Math.max(
    1,
    ...buckets.map((b) => b.conversationCount),
  );
  const percent = (value: number) =>
    Math.max(0, Math.min(100, (value - min) / (max - min) * 100));
  const cursorTime = cursor?.getTime();
  const commitRange = (from: number, to: number) => {
    setDraft([from, to]);
    onCommitRange(new Date(from), new Date(to));
  };

  return (
    <section
      aria-label="Location history and date range"
      className="shrink-0 rounded-lg border bg-background px-3 py-2.5"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
        <h2 className="font-medium text-foreground">Location history</h2>
        <div
          className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground"
          aria-label="History chart legend"
        >
          <span>
            <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-teal-500" />Time
            at stops
          </span>
          <span>
            <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-violet-500" />Conversations
          </span>
          {cursor && (
            <span>
              <span className="mr-1.5 inline-block h-2.5 w-0.5 bg-amber-500" />Selected
              moment
            </span>
          )}
          <span className="text-[11px]">Each row has its own scale</span>
        </div>
      </div>
      <div
        className="relative mx-2 h-14 rounded bg-muted/30"
        aria-label="Activity across all dates"
      >
        <div
          className="pointer-events-none absolute inset-y-0 bg-blue-500/10"
          style={{
            left: `${percent(draft[0])}%`,
            width: `${percent(draft[1]) - percent(draft[0])}%`,
          }}
        />
        {scaleMarks.slice(1, -1).map(({ fraction, className }) => (
          <span
            key={fraction}
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-0 border-l border-border ${className}`}
            style={{ left: `${fraction * 100}%` }}
          />
        ))}
        {buckets.map((bucket) => {
          const from = new Date(bucket.start).getTime();
          const to = new Date(bucket.end).getTime();
          const selected = to > draft[0] && from < draft[1];
          const label = `${dateLabel(from)} — ${dateLabel(to)}: ${
            durationLabel(bucket.dwellMs)
          } at stops, ${bucket.stayCount} stops, ${bucket.conversationCount} conversations`;
          return (
            <button
              type="button"
              key={from}
              title={label}
              aria-label={label}
              className="absolute inset-y-0 flex min-w-px flex-col gap-1 px-px hover:bg-primary/10 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              style={{
                left: `${percent(from)}%`,
                width: `${Math.max(0, percent(to) - percent(from))}%`,
                opacity: selected ? 1 : 0.28,
              }}
              onClick={() => onSelectTime(new Date((from + to) / 2))}
            >
              <span className="flex h-6 w-full items-end">
                <span
                  className="w-full rounded-t-sm bg-teal-500/80"
                  style={{ height: `${bucket.dwellMs / maxDwell * 100}%` }}
                />
              </span>
              <span className="flex h-6 w-full items-end">
                <span
                  className="w-full rounded-t-sm bg-violet-500/80"
                  style={{
                    height: `${
                      bucket.conversationCount / maxConversations * 100
                    }%`,
                  }}
                />
              </span>
            </button>
          );
        })}
        {buckets.length === 0 && (
          <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            No activity summary yet
          </span>
        )}
        {draft.map((value, index) => (
          <span
            key={index}
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 w-px bg-blue-600/85 dark:bg-blue-400/85"
            style={{ left: `${percent(value)}%` }}
          />
        ))}
        {cursorTime !== undefined && cursorTime >= min && cursorTime <= max && (
          <span
            className="pointer-events-none absolute inset-y-0 w-0.5 bg-amber-500"
            style={{ left: `${percent(cursorTime)}%` }}
          />
        )}
      </div>
      <div className="relative mx-2 h-5 text-[11px] tabular-nums text-muted-foreground">
        {scaleMarks.map(({ fraction, className }) => {
          const value = Math.round(min + (max - min) * fraction);
          return (
            <div
              key={fraction}
              className={`absolute top-0 whitespace-nowrap pt-1 ${className}`}
              style={{ left: `${fraction * 100}%` }}
            >
              <time
                dateTime={new Date(value).toISOString()}
                title={dateTimeLabel(value)}
              >
                {scaleLabel(value, max - min)}
              </time>
            </div>
          );
        })}
      </div>
      <Slider
        min={min}
        max={max}
        step={max - min >= 60_000 ? 60_000 : 1}
        minStepsBetweenThumbs={1}
        value={draft}
        thumbLabels={["Selected period start", "Selected period end"]}
        thumbValueTexts={draft.map(dateTimeLabel)}
        aria-describedby={helpId}
        className="h-7 [&_[role=slider]]:border-2 [&_[role=slider]]:border-blue-600 [&_[role=slider]]:focus-visible:ring-blue-500 dark:[&_[role=slider]]:border-blue-400"
        rangeClassName="bg-blue-600 dark:bg-blue-400"
        onValueChange={setDraft}
        onValueCommit={([from, to]) => commitRange(from, to)}
      />
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-blue-500/25 bg-blue-500/5 px-2.5 py-1.5">
        <div className="grid flex-1 grid-cols-2 gap-x-4">
          {["From", "To"].map((label, index) => (
            <div key={label} className="text-xs">
              <div className="font-medium text-blue-700 dark:text-blue-300">
                {label}
              </div>
              <time
                className="font-semibold tabular-nums"
                dateTime={new Date(draft[index]).toISOString()}
              >
                {dateTimeLabel(draft[index])}
              </time>
            </div>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {rangeDuration(draft[1] - draft[0])} selected
          </span>
          <Popover
            open={editorOpen}
            onOpenChange={(open) => {
              setEditorOpen(open);
              if (open) {
                setFromInput(localDateTimeInput(draft[0]));
                setToInput(localDateTimeInput(draft[1]));
                setEditorError("");
              }
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
              >
                <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                Edit dates
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="top"
              aria-labelledby={editorTitleId}
            >
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const from = fromInput === localDateTimeInput(draft[0])
                    ? draft[0]
                    : new Date(fromInput).getTime();
                  const to = toInput === localDateTimeInput(draft[1])
                    ? draft[1]
                    : new Date(toInput).getTime();
                  if (
                    !Number.isFinite(from) || !Number.isFinite(to) || from >= to
                  ) {
                    setEditorError(
                      "Choose an end date and time after the start.",
                    );
                    return;
                  }
                  if (from !== draft[0] || to !== draft[1]) {
                    commitRange(from, to);
                  }
                  setEditorOpen(false);
                }}
              >
                <h3 id={editorTitleId} className="text-sm font-medium">
                  Map date range
                </h3>
                <label className="block space-y-1 text-xs">
                  <span>From</span>
                  <Input
                    className="h-8 text-sm"
                    type="datetime-local"
                    required
                    value={fromInput}
                    onChange={(event) => {
                      setFromInput(event.target.value);
                      setEditorError("");
                    }}
                  />
                </label>
                <label className="block space-y-1 text-xs">
                  <span>To</span>
                  <Input
                    className="h-8 text-sm"
                    type="datetime-local"
                    required
                    aria-invalid={!!editorError}
                    aria-describedby={editorError ? editorErrorId : undefined}
                    value={toInput}
                    onChange={(event) => {
                      setToInput(event.target.value);
                      setEditorError("");
                    }}
                  />
                </label>
                {editorError && (
                  <p
                    id={editorErrorId}
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {editorError}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditorOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="sm">Apply</Button>
                </div>
              </form>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <p id={helpId} className="mt-1 text-[11px] text-muted-foreground">
        Drag either handle or edit the dates. Click an activity bar to inspect a
        moment.
      </p>
    </section>
  );
}
