import { z } from "zod";
import { zDateOrRelativeTime } from "@myceliasdk/zod-json-schema.ts";
import type { MongoRequest, MongoResponse } from "@/lib/mongo/core.server.ts";

export const searchTripsSchema = z.object({
  action: z.literal("searchTrips").describe(
    "Find when and where the user was physically present using geocoded GPS stays. Use first for personal trips, dates and visited countries or cities. Omit place filters to list recent visits.",
  ),
  country: z.string().trim().min(1).max(100).optional().describe(
    "ISO 3166-1 alpha-2 country code (preferred) or English country name. Translate the user's country into its code.",
  ),
  city: z.string().trim().min(1).max(150).optional().describe(
    "City name as used by GeoNames. Translate inflected names to their canonical spelling. May be combined with country.",
  ),
  startDate: zDateOrRelativeTime(
    "Include GPS stays overlapping this start time",
  ).optional(),
  endDate: zDateOrRelativeTime("Include GPS stays overlapping this end time")
    .optional(),
  limit: z.number().int().min(1).max(25).default(10),
});

const MAX_OBSERVATION_GAP_MS = 3 * 24 * 60 * 60 * 1000;

export async function searchGpsTrips(
  mongo: (request: MongoRequest) => Promise<MongoResponse>,
  input: z.infer<typeof searchTripsSchema>,
) {
  const { city, country, startDate, endDate, limit } = input;
  if (startDate && endDate && startDate > endDate) {
    throw new Error("startDate must be on or before endDate");
  }
  const placeFilter: Record<string, string> = {};
  if (city) placeFilter["place.city"] = city;
  if (country) {
    placeFilter[country.length === 2 ? "place.countryCode" : "place.country"] =
      country;
  }

  // Number runs before filtering by destination so a recorded visit elsewhere
  // separates two visits even when the user returned on the same day.
  const sortBy = { start: 1, _id: 1 };
  const visits: Array<{
    country: string;
    countryCode: string;
    cities: string[];
    stays: number;
    first: Date;
    last: Date;
    firstLocalDate: string;
    lastLocalDate: string;
  }> = await mongo({
    action: "aggregate",
    collection: "location_segments",
    options: { collation: { locale: "en", strength: 1 } },
    pipeline: [
      {
        $match: {
          type: "stay",
          source: { $ne: "manual" },
          start: { $type: "date", ...(endDate && { $lte: endDate }) },
          end: { $type: "date", ...(startDate && { $gte: startDate }) },
        },
      },
      {
        $project: {
          start: startDate ? { $max: ["$start", startDate] } : 1,
          end: endDate ? { $min: ["$end", endDate] } : 1,
          place: 1,
          timeZone: { $ifNull: ["$timeZone", "UTC"] },
          destination: {
            country: "$place.countryCode",
            ...(city && { city: "$place.city" }),
          },
        },
      },
      {
        $setWindowFields: {
          sortBy,
          output: {
            previous: { $shift: { output: "$destination", by: -1 } },
            previousEnd: { $shift: { output: "$end", by: -1 } },
          },
        },
      },
      {
        $setWindowFields: {
          sortBy,
          output: {
            visit: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $ne: ["$previous", "$destination"] },
                      {
                        $gt: [
                          { $subtract: ["$start", "$previousEnd"] },
                          MAX_OBSERVATION_GAP_MS,
                        ],
                      },
                    ],
                  },
                  1,
                  0,
                ],
              },
              window: { documents: ["unbounded", "current"] },
            },
          },
        },
      },
      { $match: { "place.countryCode": { $type: "string" }, ...placeFilter } },
      {
        $group: {
          _id: "$visit",
          country: { $first: "$place.country" },
          countryCode: { $first: "$place.countryCode" },
          cities: { $addToSet: "$place.city" },
          stays: { $sum: 1 },
          first: { $min: "$start" },
          last: { $max: "$end" },
          firstZone: {
            $top: { sortBy: { start: 1, _id: 1 }, output: "$timeZone" },
          },
          lastZone: {
            $top: { sortBy: { end: -1, _id: 1 }, output: "$timeZone" },
          },
        },
      },
      { $sort: { first: -1, _id: -1 } },
      { $limit: limit + 1 },
      {
        $project: {
          _id: 0,
          country: 1,
          countryCode: 1,
          cities: 1,
          stays: 1,
          first: 1,
          last: 1,
          firstLocalDate: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$first",
              timezone: "$firstZone",
            },
          },
          lastLocalDate: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$last",
              timezone: "$lastZone",
            },
          },
        },
      },
    ],
  });
  return {
    source: "location_segments",
    evidence:
      "Dates bound recorded GPS stays in local time. Gaps in coverage are possible. Arrival and departure times are unknown.",
    hasMore: visits.length > limit,
    visits: visits.slice(0, limit).map(({ first, last, ...visit }) => ({
      ...visit,
      mapUrl:
        `/map?start=${first.getTime()}&end=${last.getTime()}&layers=presence,routes`,
    })),
  };
}
