import { z } from "zod";
import { ObjectId } from "bson";
import { Resource } from "@/lib/auth/resources.ts";
import { Auth } from "@/lib/auth/core.server.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { zDateOrRelativeTime } from "@myceliasdk/zod-json-schema.ts";

// Schema for searching transcriptions (your recorded conversations/audio)
const searchTranscriptionsSchema = z.object({
  action: z.literal("searchTranscriptions").describe(
    "Search through transcribed audio recordings. Use this to find what was said in voice recordings, meetings, or any transcribed content.",
  ),
  query: z.string().describe(
    "Case-insensitive partial match. Use an empty string with startDate and endDate to list recordings in a date range without a keyword.",
  ),
  startDate: zDateOrRelativeTime(
    "Filter results from this date onwards (ISO 8601 or relative like '7d' for 7 days ago)",
  ).optional(),
  endDate: zDateOrRelativeTime(
    "Filter results up to this date (ISO 8601 or relative)",
  ).optional(),
  limit: z.number().max(50).default(20).describe(
    "Maximum number of results to return (default: 20, max: 50)",
  ),
});

// Schema for searching messages (chat conversations with AI or messengers)
const searchMessagesSchema = z.object({
  action: z.literal("searchMessages").describe(
    "Search through chat messages from AI conversations or imported messenger chats (Telegram, etc.)",
  ),
  query: z.string().describe(
    "Search text to find in messages (case-insensitive, partial match)",
  ),
  platform: z.string().optional().describe(
    "Filter by platform: 'mycelia' (AI chats), 'telegram', etc. Leave empty for all platforms.",
  ),
  chatId: z.string().optional().describe(
    "Filter to a specific chat/conversation ID",
  ),
  startDate: zDateOrRelativeTime(
    "Filter results from this date onwards",
  ).optional(),
  endDate: zDateOrRelativeTime(
    "Filter results up to this date",
  ).optional(),
  limit: z.number().max(100).default(30).describe(
    "Maximum number of results to return (default: 30, max: 100)",
  ),
});

// Schema for searching objects (knowledge graph - people, events, places, relationships)
const searchObjectsSchema = z.object({
  action: z.literal("searchObjects").describe(
    "Search through the knowledge graph: people, events, places, relationships, and promises. Use for finding entities and their connections. Searches names, aliases, details, and summaries.",
  ),
  query: z.string().describe(
    "Search text to find in object names, aliases, details, and summaries. Uses full-text search with relevance ranking.",
  ),
  types: z.array(
    z.enum([
      "person",
      "event",
      "relationship",
      "promise",
      "place",
      "organization",
      "product",
      "project",
      "animal",
      "concept",
      "media",
      "any",
    ]),
  ).default(["any"]).describe(
    "Filter by object types. Use 'any' to search all types.",
  ),
  startDate: zDateOrRelativeTime(
    "Filter objects active/created after this date",
  ).optional(),
  endDate: zDateOrRelativeTime(
    "Filter objects active/created before this date",
  ).optional(),
  limit: z.number().max(50).default(20).describe(
    "Maximum number of results to return (default: 20, max: 50)",
  ),
});

const searchMediaSchema = z.object({
  action: z.literal("searchMedia").describe(
    "Search OCR text and recognized labels in imported photos and PDF documents.",
  ),
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(50).default(20),
});

const searchRequestSchema = z.discriminatedUnion("action", [
  searchTranscriptionsSchema,
  searchMessagesSchema,
  searchObjectsSchema,
  searchMediaSchema,
]);

export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchResponse = any;

function parseDate(dateInput: Date | undefined): Date | undefined {
  return dateInput;
}

const TRANSCRIPTION_TEXT_LIMIT = 8_000;

export function escapeMongoRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assembleTranscriptionText(transcription: {
  text?: unknown;
  segments?: Array<{ text?: unknown }>;
}): string {
  if (
    typeof transcription.text === "string" &&
    transcription.text.trim().length > 0
  ) {
    return transcription.text;
  }

  return (transcription.segments ?? [])
    .map((segment) =>
      typeof segment?.text === "string" ? segment.text.trim() : ""
    )
    .filter(Boolean)
    .join(" ");
}

export function truncateTranscriptionText(
  text: string,
  search: string,
  limit = TRANSCRIPTION_TEXT_LIMIT,
): { text: string; textLength: number; textTruncated: boolean } {
  const textLength = text.length;
  if (textLength <= limit) {
    return { text, textLength, textTruncated: false };
  }

  const matchIndex = search
    ? text.toLocaleLowerCase().indexOf(search.toLocaleLowerCase())
    : -1;
  const start = matchIndex < 0 ? 0 : Math.min(
    Math.max(0, matchIndex - Math.floor((limit - search.length) / 2)),
    textLength - limit,
  );

  return {
    text: text.slice(start, start + limit),
    textLength,
    textTruncated: true,
  };
}

export class SearchResource implements Resource<SearchRequest, SearchResponse> {
  code = "search";
  description = `Search tool for finding information across your personal data.

Available actions:
- searchTranscriptions: Find content in voice recordings/transcriptions
- searchMessages: Find content in chat conversations
- searchObjects: Find people, events, places, relationships in knowledge graph (searches names, details, summaries)
- searchMedia: Find OCR text and recognized labels in photos and PDFs`;

  schemas = {
    request: searchRequestSchema as z.ZodType<SearchRequest>,
    response: z.any(),
  };

  async use(input: SearchRequest, auth: Auth): Promise<SearchResponse> {
    const mongo = await getMongoResource(auth);

    switch (input.action) {
      case "searchMedia": {
        const media = auth.getResource<any, any>("media");
        return await media({
          action: "search",
          query: input.query,
          limit: input.limit,
        });
      }
      case "searchTranscriptions": {
        const searchRegex = {
          $regex: escapeMongoRegex(input.query),
          $options: "i",
        };
        const query: any = {
          $or: [
            { text: searchRegex },
            { "segments.text": searchRegex },
          ],
        };

        const startDate = parseDate(input.startDate);
        const endDate = parseDate(input.endDate);

        if (startDate) query.start = { ...query.start, $gte: startDate };
        if (endDate) query.end = { ...query.end, $lte: endDate };

        const results = await mongo({
          action: "find",
          collection: "transcriptions",
          query,
          options: {
            sort: { start: -1 },
            limit: input.limit + 1,
            projection: {
              _id: 1,
              text: 1,
              "segments.text": 1,
              start: 1,
              end: 1,
              duration: 1,
            },
          },
        });

        const hasMore = results.length > input.limit;
        const returnedResults = results.slice(0, input.limit);

        return {
          source: "transcriptions",
          count: returnedResults.length,
          hasMore,
          results: returnedResults.map((r: any) => {
            const text = truncateTranscriptionText(
              assembleTranscriptionText(r),
              input.query,
            );
            return {
              id: r._id,
              ...text,
              start: r.start,
              end: r.end,
              duration: r.duration,
              type: "transcription",
            };
          }),
        };
      }

      case "searchMessages": {
        const searchRegex = {
          $regex: escapeMongoRegex(input.query),
          $options: "i",
        };
        const query: any = {
          $or: [
            { text: searchRegex },
            { "raw.content": searchRegex },
          ],
        };

        if (input.platform) query.platform = input.platform;
        if (input.chatId) query.chatId = new ObjectId(input.chatId);

        const startDate = parseDate(input.startDate);
        const endDate = parseDate(input.endDate);

        if (startDate) {
          query.timestamp = { ...query.timestamp, $gte: startDate };
        }
        if (endDate) query.timestamp = { ...query.timestamp, $lte: endDate };

        const results = await mongo({
          action: "find",
          collection: "messages",
          query,
          options: {
            sort: { timestamp: -1 },
            limit: input.limit,
            projection: {
              _id: 1,
              text: 1,
              timestamp: 1,
              platform: 1,
              chatId: 1,
              "raw.role": 1,
            },
          },
        });

        return {
          source: "messages",
          count: results.length,
          results: results.map((r: any) => ({
            id: r._id,
            text: r.text,
            timestamp: r.timestamp,
            platform: r.platform,
            chatId: r.chatId,
            role: r.raw?.role,
            type: "message",
          })),
        };
      }

      case "searchObjects": {
        // Use MongoDB text search (faster and includes summaries)
        const query: any = {
          $text: { $search: input.query },
        };

        // Build additional filters
        const additionalFilters: any[] = [];

        // Filter by types
        if (input.types && !input.types.includes("any")) {
          const typeFilters: any[] = [];
          if (input.types.includes("person")) {
            typeFilters.push({ isPerson: true });
          }
          if (input.types.includes("event")) {
            typeFilters.push({ isEvent: true });
          }
          if (input.types.includes("relationship")) {
            typeFilters.push({ isRelationship: true });
          }
          if (input.types.includes("promise")) {
            typeFilters.push({ isPromise: true });
          }
          if (input.types.includes("place")) {
            typeFilters.push({ isPlace: true });
          }
          if (input.types.includes("organization")) {
            typeFilters.push({ isOrganization: true });
          }
          if (input.types.includes("product")) {
            typeFilters.push({ isProduct: true });
          }
          if (input.types.includes("project")) {
            typeFilters.push({ isProject: true });
          }
          if (input.types.includes("animal")) {
            typeFilters.push({ isAnimal: true });
          }
          if (input.types.includes("concept")) {
            typeFilters.push({ isConcept: true });
          }
          if (input.types.includes("media")) {
            typeFilters.push({ isMedia: true });
          }
          if (typeFilters.length > 0) {
            additionalFilters.push({ $or: typeFilters });
          }
        }

        const startDate = parseDate(input.startDate);
        const endDate = parseDate(input.endDate);

        if (startDate || endDate) {
          const timeRangeQuery: any = {};
          if (startDate) timeRangeQuery.$gte = startDate;
          if (endDate) timeRangeQuery.$lte = endDate;
          additionalFilters.push({ "timeRanges.start": timeRangeQuery });
        }

        // Combine all filters
        if (additionalFilters.length > 0) {
          query.$and = additionalFilters;
        }

        const results = await mongo({
          action: "find",
          collection: "objects",
          query,
          options: {
            // Sort by text relevance score (best matches first)
            sort: { score: { $meta: "textScore" } },
            limit: input.limit,
            projection: {
              _id: 1,
              name: 1,
              details: 1,
              summaries: 1,
              icon: 1,
              isPerson: 1,
              isEvent: 1,
              isRelationship: 1,
              isPromise: 1,
              isPlace: 1,
              isOrganization: 1,
              isProduct: 1,
              isProject: 1,
              isAnimal: 1,
              isConcept: 1,
              isMedia: 1,
              timeRanges: 1,
              score: { $meta: "textScore" },
            },
          },
        });

        return {
          source: "objects",
          count: results.length,
          results: results.map((r: any) => ({
            id: r._id,
            name: r.name,
            details: r.details,
            icon: r.icon,
            type: r.isPerson
              ? "person"
              : r.isEvent
              ? "event"
              : r.isRelationship
              ? "relationship"
              : r.isPromise
              ? "promise"
              : r.isPlace
              ? "place"
              : r.isOrganization
              ? "organization"
              : r.isProduct
              ? "product"
              : r.isProject
              ? "project"
              : r.isAnimal
              ? "animal"
              : r.isConcept
              ? "concept"
              : r.isMedia
              ? "media"
              : "object",
            timeRanges: r.timeRanges,
            score: r.score, // Text search relevance score
          })),
        };
      }

      default:
        throw new Error("Unknown search action");
    }
  }

  extractActions(input: SearchRequest) {
    return [
      {
        path: ["search"],
        actions: ["read"],
      },
    ];
  }
}

export function getSearchResource(
  auth: Auth,
): (input: SearchRequest) => Promise<SearchResponse> {
  return auth.getResource<SearchRequest, SearchResponse>("search");
}
