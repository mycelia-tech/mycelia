import { Layer, type LayerComponentProps, Tool } from "@/core/core.ts";
import React, { useMemo, useRef } from "react";

import { AudioPlayer, useAudioPlayer } from "./player.tsx";
import { AudioTimelineTrack } from "./AudioTimelineTrack.tsx";
import { TimelineItems } from "./TimelineItems.tsx";
import { useTimelineRange } from "@/stores/timelineRange.ts";
import { PlayPauseButton } from "./PlayPauseButton.tsx";
import GainSlider from "./GainSlider.tsx";
import { useTranscripts } from "./useTranscripts.ts";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { useHistogramItems } from "@/modules/histogram/useHistogramItems";

export const AudioPlayerTool: Tool = {
  component: () => {
    return (
      <>
        <PlayPauseButton />
      </>
    );
  },
  tooltip: "Play/Pause",
};

export const GainTool: Tool = {
  component: () => {
    return <GainSlider />;
  },
  tooltip: "Adjust volume gain",
};

export const DateTimePickerTool: Tool = {
  component: () => {
    const { currentDate, resetDate } = useAudioPlayer();

    return (
      <DateTimePicker
        value={currentDate ?? undefined}
        onChange={resetDate}
        placeholder="Jump to date and time"
        precision="second"
        nullable
      />
    );
  },
  tooltip: "Jump to specific date/time",
};

export const AudioLayer: () => Layer = () => {
  return {
    component: AudioTimelineTrack,
  } as Layer;
};

export const TranscriptLayer: () => Layer = () => {
  return {
    component: () => {
      const { currentDate, resetDate } = useAudioPlayer();
      const { transcripts } = useTranscripts(currentDate);
      const containerRef = useRef<HTMLDivElement | null>(null);
      const itemRefs = useRef<Record<string, HTMLParagraphElement | null>>({});
      // useEffect(() => {
      //   if (!currentDate) return;
      //   const active = transcripts.find((t) => t.start <= currentDate && currentDate <= t.end);
      //   if (!active) return;
      //   const el = itemRefs.current[String(active._id)];
      //   if (el && containerRef.current) {
      //     el.scrollIntoView({ block: "nearest" });
      //   }
      // }, [currentDate, transcripts.map((t) => t._id).join(",")]);

      return (
        <div>
          <div
            ref={containerRef}
            className="mt-2 space-y-1 h-32 overflow-y-auto overscroll-none"
          >
            {transcripts.length === 0
              ? (
                <div className="h-full flex items-center text-gray-400 italic">
                  <p className="text-sm">
                    ... transcripts will be shown here...
                  </p>
                </div>
              )
              : (
                transcripts.map((transcript) => {
                  const isActive = !!currentDate &&
                    transcript.start <= currentDate;
                  const base = "text-sm italic p-1 rounded whitespace-pre-wrap";
                  const cls = isActive ? `${base} text-yellow-600` : `${base}`;
                  const formatTime = (d: Date) =>
                    d.toLocaleTimeString([], {
                      hour12: false,
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    });
                  return (
                    <div
                      key={transcript._id}
                      className="flex items-start gap-2"
                    >
                      <div className="w-20 shrink-0 text-xs text-gray-400 text-right font-mono leading-6">
                        {formatTime(transcript.start)}
                      </div>
                      <p
                        ref={(el) => {
                          itemRefs.current[String(transcript._id)] = el;
                        }}
                        className={cls}
                      >
                        {transcript.segments.map((segment, idx) => (
                          <span
                            onClick={() => {
                              resetDate(new Date(segment.start));
                            }}
                            key={idx}
                          >
                            {segment.text}
                          </span>
                        ))}
                      </p>
                    </div>
                  );
                })
              )}
          </div>
        </div>
      );
    },
  } as Layer;
};

export const TopicsLayer: () => Layer = () => {
  return {
    component: ({ width }: LayerComponentProps) => {
      let { start, end } = useTimelineRange();
      const { currentDate } = useAudioPlayer();
      const centerMs = currentDate
        ? currentDate.getTime()
        : (start.getTime() + end.getTime()) / 2;
      start = new Date(centerMs - 1000 * 60 * 30);
      end = new Date(centerMs + 1000 * 60 * 30);

      const resolution = "5min";

      const { items } = useHistogramItems(start, end, resolution);

      const sToShift = (s: { ts: number; siblingCount: number }) => {
        return (s.ts - centerMs) / 100 / (s.siblingCount) + width / 2;
      };

      const layout = useMemo(() => {
        return items
          .filter((i) => (i.topics?.length ?? 0) > 0)
          .flatMap((i) => {
            const topics = i.topics || [];
            const startMs = i.start.getTime();
            const segmentMs = startMs + 2.5 * 60 * 100;
            return topics.map((topic, idx) => {
              const segStartMs = startMs + idx * segmentMs;
              const seg = {
                id: `${i.id}-${idx}`,
                ts: segStartMs,
                topic,
                siblingCount: topics.length,
                idx,
              };
              return { ...seg, x: sToShift(seg) };
            });
          });
      }, [items, currentDate, centerMs]);

      const baselineY = 14;

      return (
        <div className="relative h-[28px]">
          {layout.map((p) => {
            return (
              <span
                key={`topics-${p.id}`}
                style={{
                  transform: `translate(${p.x}px, ${baselineY}px)`,
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: "100%",
                  height: "30px",
                }}
                className="text-[10px] fill-white opacity-90"
              >
                {p.idx === 0 && (
                  <span className="text-yellow-600">
                    {new Date(p.ts).toLocaleTimeString([], {
                      hour12: false,
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                )} {JSON.stringify(p.topic)}
              </span>
            );
          })}
        </div>
      );
    },
  } as Layer;
};
