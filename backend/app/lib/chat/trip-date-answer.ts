import type { StreamTextTransform, ToolSet } from "ai";
import { z } from "zod";

export const GPS_TRIP_TOOL = "search_searchTrips";

// Direct rendering is for a single destination and a plain date question.
// Leave comparisons, follow-ups and compound questions to normal synthesis.
export function tripDateLocale(question: string): "ru" | "en" | undefined {
  const text = question.trim().replace(/[?.!]+$/, "").trim();
  const prefix =
    /^(?:когда я (?:был[аи]?|ездил[аи]?|побывал[аи]?) (?:в|во|на)|when (?:was I in|did I visit|did I go to))\s+/iu
      .exec(text);
  if (!prefix) return;
  const destination = text.slice(prefix[0].length);
  if (!/^\p{L}[\p{L}’'-]*(?:\s+\p{Lu}[\p{L}’'-]*){0,4}$/u.test(destination)) {
    return;
  }
  return /^когда/iu.test(text) ? "ru" : "en";
}

const resultSchema = z.object({
  type: z.literal("json"),
  value: z.object({
    source: z.literal("location_segments"),
    hasMore: z.boolean(),
    visits: z.array(z.object({
      countryCode: z.string().regex(/^[a-z]{2}$/i),
      cities: z.array(z.string()),
      firstLocalDate: z.iso.date(),
      lastLocalDate: z.iso.date(),
      mapUrl: z.string().regex(
        /^\/map\?start=\d+&end=\d+&layers=presence,routes$/,
      ),
    })).min(1),
  }),
});

export function directTripDateAnswer(locale: "ru" | "en") {
  const dates = new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeZone: "UTC",
  });
  const regions = new Intl.DisplayNames(locale, { type: "region" });
  let completed = false;
  const transform: StreamTextTransform<ToolSet> = () => {
    let answer = "";
    let calls = 0;
    return new TransformStream({
      transform(part, controller) {
        if (part.type === "start-step") {
          calls = 0;
          answer = "";
        }
        if (part.type === "tool-call") calls++;
        if (
          part.type === "tool-result" && part.toolName === GPS_TRIP_TOOL &&
          !part.preliminary
        ) {
          const args = part.input as { city?: string; country?: string };
          const parsed = resultSchema.safeParse(part.output);
          if ((args.city || args.country) && parsed.success) {
            const lines = parsed.data.value.visits.map((visit) => {
              const range = dates.formatRange(
                new Date(visit.firstLocalDate),
                new Date(visit.lastLocalDate),
              );
              const place = [
                regions.of(visit.countryCode.toUpperCase()),
                ...visit.cities,
              ].join(", ");
              const map = locale === "ru" ? "На карте" : "Map";
              return `${place} — **${range}**. [${map}](${visit.mapUrl})`;
            });
            const intro = locale === "ru"
              ? "По данным GPS:"
              : "Recorded GPS stays:";
            const more = locale === "ru"
              ? "Есть и более ранние поездки."
              : "There are earlier visits.";
            answer = [
              intro,
              ...lines,
              ...(parsed.data.value.hasMore ? [more] : []),
            ].join("\n\n");
          }
        }
        if (
          part.type === "finish-step" && answer && calls === 1 &&
          part.finishReason === "tool-calls"
        ) {
          const id = crypto.randomUUID();
          controller.enqueue({ type: "text-start", id });
          controller.enqueue({ type: "text-delta", id, text: answer });
          controller.enqueue({ type: "text-end", id });
          completed = true;
        }
        if (
          completed && (part.type === "finish-step" || part.type === "finish")
        ) {
          controller.enqueue({ ...part, finishReason: "stop" });
        } else {
          controller.enqueue(part);
        }
      },
    });
  };
  return { transform, completed: () => completed };
}
