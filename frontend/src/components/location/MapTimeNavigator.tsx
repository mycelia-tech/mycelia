import { useEffect, useId, useState } from "react";
import { Slider } from "@/components/ui/slider";
import type { MapTimelineSummary } from "@/types/location";

function dateLabel(value: number) {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
function durationLabel(ms: number) {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
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
  const dataStart = summary
    ? new Date(summary.dataRange.start).getTime()
    : start.getTime();
  const dataEnd = summary
    ? new Date(summary.dataRange.end).getTime()
    : end.getTime();
  const min = Math.min(dataStart, start.getTime());
  const max = Math.max(min + 1, dataEnd, end.getTime());
  const [draft, setDraft] = useState([start.getTime(), end.getTime()]);
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
        className="relative h-14 rounded bg-muted/30"
        aria-label="Activity across all dates"
      >
        <div
          className="pointer-events-none absolute inset-y-0 border-x border-primary/40 bg-primary/5"
          style={{
            left: `${percent(draft[0])}%`,
            width: `${percent(draft[1]) - percent(draft[0])}%`,
          }}
        />
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
        {cursorTime !== undefined && cursorTime >= min && cursorTime <= max && (
          <span
            className="pointer-events-none absolute inset-y-0 w-0.5 bg-amber-500"
            style={{ left: `${percent(cursorTime)}%` }}
          />
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{dateLabel(min)}</span>
        <span>{dateLabel(max)}</span>
      </div>
      <div className="mb-1 mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
        <span>
          <span className="mr-1 text-muted-foreground">From</span>
          <strong className="font-medium">{dateLabel(draft[0])}</strong>
        </span>
        <span>
          <span className="mr-1 text-muted-foreground">To</span>
          <strong className="font-medium">{dateLabel(draft[1])}</strong>
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={max - min >= 60_000 ? 60_000 : 1}
        minStepsBetweenThumbs={1}
        value={draft}
        thumbLabels={["Selected period start", "Selected period end"]}
        thumbValueTexts={draft.map((value) => new Date(value).toLocaleString())}
        aria-describedby={helpId}
        className="h-6"
        onValueChange={setDraft}
        onValueCommit={(values) =>
          onCommitRange(new Date(values[0]), new Date(values[1]))}
      />
      <p id={helpId} className="mt-1 text-[11px] text-muted-foreground">
        Drag the two handles to choose the map’s date range. Click a bar to
        inspect a moment.
      </p>
    </section>
  );
}
