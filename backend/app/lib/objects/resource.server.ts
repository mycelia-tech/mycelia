import { z } from "zod";
import { ObjectId } from "bson";
import { Resource } from "@/lib/auth/resources.ts";
import { Auth, getServerAuth } from "@/lib/auth/core.server.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { zDateOrString, zObjectId } from "@myceliasdk/zod-json-schema.ts";
import {
  buildTimelineObjectsPipeline,
  resolveTimelineObjectLimit,
  TIMELINE_OBJECT_MAX_TIME_MS,
  TIMELINE_OBJECT_RANGE_INDEX,
} from "./timeline-query.ts";
import {
  deriveEntityTypingPending,
  deriveObjectListCategories,
  OBJECT_LIST_CATEGORIES,
  OBJECT_LIST_TYPE_FLAGS,
} from "./list-categories.ts";
import { listObjectCards } from "./list-cards.ts";
import {
  isObjectListCatalogReady,
  repairObjectListCatalog,
} from "./list-catalog.ts";
import { getObjectTimelineDensity } from "./timeline-density.server.ts";
import {
  OBJECT_DENSITY_RESOLUTIONS,
  TIMELINE_OBJECT_CATEGORIES,
} from "./timeline-density.ts";
import { listTagOptions } from "./tag-options.ts";

const zIcon = z.union([
  z.object({
    text: z.string().describe("Emoji or text icon (e.g., '🐯', '🏠️')"),
  }),
  z.object({
    base64: z.string().describe("Base64-encoded image data"),
  }),
]);

const zObjectInput = z.object({
  name: z.string().min(1).describe(
    "Display name of the object (person, event, place, relationship, or promise)",
  ),
  details: z.string().nullable().optional().describe(
    "Additional details or description. Can be markdown formatted.",
  ),
  icon: zIcon.optional().describe(
    "Visual icon for the object, either emoji text or base64 image",
  ),
  color: z.string().optional().describe(
    "Color code for visual representation (e.g., '#FF5733')",
  ),
  aliases: z.array(z.string()).optional().describe(
    "Alternative names or identifiers for search (e.g., ['Igor', 'Tigor'])",
  ),
  isEvent: z.boolean().optional().describe(
    "True if this object represents an event or occurrence in time",
  ),
  isPerson: z.boolean().optional().describe(
    "True if this object represents a person or entity",
  ),
  isRelationship: z.boolean().optional().describe(
    "True if this object represents a relationship between two other objects. Requires 'relationship' field.",
  ),
  isPromise: z.boolean().optional().describe(
    "True if this object represents a promise or commitment",
  ),
  isPlace: z.boolean().optional().describe(
    "True if this object represents a physical place or location (city, country, venue)",
  ),
  isOrganization: z.boolean().optional().describe(
    "True if this object represents an organization, company, institution, or group",
  ),
  isProduct: z.boolean().optional().describe(
    "True if this object represents a product, app, service, or piece of software",
  ),
  isProject: z.boolean().optional().describe(
    "True if this object represents a named project or initiative",
  ),
  isAnimal: z.boolean().optional().describe(
    "True if this object represents an animal or pet",
  ),
  isConcept: z.boolean().optional().describe(
    "True if this object represents an abstract concept, topic, technology, language, or idea",
  ),
  isMedia: z.boolean().optional().describe(
    "True if this object represents a creative work: book, film, series, song, game, article, or fictional character",
  ),
  starred: z.boolean().optional().describe(
    "True if the user has starred/favorited this object",
  ),
  relationship: z.object({
    object: zObjectId().describe(
      "The object/target of the relationship (the 'to' entity)",
    ),
    subject: zObjectId().describe(
      "The subject/source of the relationship (the 'from' entity)",
    ),
    symmetrical: z.boolean().describe(
      "True if relationship goes both ways (e.g., 'partner' relationship), false for directional (e.g., 'lives in')",
    ),
  }).optional().describe(
    "Defines the relationship structure. Only used when isRelationship=true. Example: 'Me lives in Amsterdam' has subject=Me, object=Amsterdam, symmetrical=false",
  ),
  location: z.object({
    latitude: z.number().describe("Geographic latitude (-90 to 90)"),
    longitude: z.number().describe("Geographic longitude (-180 to 180)"),
  }).optional().describe(
    "Geographic coordinates for places or events with physical location",
  ),
  timeRanges: z.array(z.object({
    start: zDateOrString().describe("Start date/time of this time period"),
    end: zDateOrString().optional().describe(
      "End date/time. Omit for ongoing/current periods",
    ),
    name: z.string().optional().describe("Optional label for this time period"),
  })).optional().describe(
    "Time periods when this object/relationship was active. Multiple ranges supported for non-continuous periods.",
  ),
}).loose().refine(
  (object) =>
    !Object.keys(object).some((field) =>
      field === "_listCategories" || field.startsWith("_listCategories.")
    ),
  { message: "Internal object projection fields cannot be supplied" },
);

const createObjectSchema = z.object({
  action: z.literal("create").describe("Create a new object"),
  object: zObjectInput.describe(
    "The object data to create. Can represent people, events, places, relationships, or promises.",
  ),
});

const updateObjectSchema = z.object({
  action: z.literal("update").describe("Update a single field on an object"),
  id: z.string().describe("MongoDB ObjectId string of the object to update"),
  version: z.number().describe(
    "Current version number for optimistic locking. Get this from the object first. Update fails if version changed.",
  ),
  field: z.string().refine(
    (field) =>
      field !== "_listCategories" &&
      !field.startsWith("_listCategories."),
    { message: "Internal object projection fields cannot be updated" },
  ).describe(
    "Dot-notation path to the field to update (e.g., 'name', 'details', 'icon.text', 'timeRanges'). Set to null to remove field.",
  ),
  value: z.any().describe(
    "New value for the field. Use null to remove the field entirely.",
  ),
});

const deleteObjectSchema = z.object({
  action: z.literal("delete").describe("Delete an object permanently"),
  id: z.string().describe("MongoDB ObjectId string of the object to delete"),
});

const getObjectSchema = z.object({
  action: z.literal("get").describe("Retrieve a single object by ID"),
  id: z.string().describe("MongoDB ObjectId string of the object to retrieve"),
});

const listObjectsSchema = z.object({
  action: z.literal("list").describe(
    "List/search objects with filtering and pagination",
  ),
  view: z.enum(["full", "timeline"]).optional().describe(
    "Use the bounded compact Timeline response instead of the legacy full array",
  ),
  filters: z.record(z.string(), z.any()).optional().describe(
    "MongoDB query filters (e.g., {'isPerson': true, 'name': 'Igor'}). Leave empty for all objects.",
  ),
  options: z.object({
    limit: z.number().optional().describe(
      "Maximum number of results to return",
    ),
    skip: z.number().optional().describe(
      "Number of results to skip for pagination",
    ),
    sort: z.record(z.string(), z.number()).optional().describe(
      "Sort order as field:direction pairs (1=ascending, -1=descending). Example: {'createdAt': -1} for newest first",
    ),
    includeRelationships: z.boolean().optional().describe(
      "If true, join and include full related objects for relationships",
    ),
    hasTimeRanges: z.boolean().optional().describe(
      "If true, only return objects that have time ranges defined",
    ),
    searchTerm: z.union([z.string(), z.null()]).optional().describe(
      "Search string to match against name and aliases (case-insensitive)",
    ),
    timeRangeFilter: z.object({
      start: z.string().describe("ISO 8601 date string for range start"),
      end: z.string().describe("ISO 8601 date string for range end"),
    }).optional().describe(
      "Filter objects that overlap with the specified time range",
    ),
  }).optional().describe(
    "Query options for filtering, sorting, and pagination",
  ),
});

const getRelationshipsSchema = z.object({
  action: z.literal("getRelationships").describe(
    "Get all relationships where this object is subject or object",
  ),
  id: z.string().describe(
    "MongoDB ObjectId string of the object whose relationships to retrieve",
  ),
});

const getHistorySchema = z.object({
  action: z.literal("getHistory").describe(
    "Get version history of changes to an object",
  ),
  id: z.string().describe(
    "MongoDB ObjectId string of the object whose history to retrieve",
  ),
  limit: z.number().max(500).nullish().describe(
    "Maximum number of history entries to return (default: 50, max: 500)",
  ),
  skip: z.number().nullish().describe(
    "Number of history entries to skip for pagination",
  ),
});

const exploreTimeRangeSchema = z.object({
  action: z.literal("exploreTimeRange").describe(
    "Find objects that refer to a specific time range",
  ),
  start: zDateOrString().describe(
    "(ISO 8601 date string or Date object)",
  ),
  end: zDateOrString().describe(
    "(ISO 8601 date string or Date object)",
  ),
  filters: z.record(z.string(), z.any()).optional().describe(
    "Additional MongoDB query filters to apply (e.g., {'isPerson': true})",
  ),
  options: z.object({
    limit: z.number().optional().describe(
      "Maximum number of results to return",
    ),
    skip: z.number().optional().describe(
      "Number of results to skip for pagination",
    ),
    sort: z.record(z.string(), z.number()).optional().describe(
      "Sort order as field:direction pairs (1=ascending, -1=descending)",
    ),
    includeRelationships: z.boolean().optional().describe(
      "If true, join and include full related objects for relationships",
    ),
  }).optional().describe("Query options for sorting and pagination"),
});

const getTimeRangeSchema = z.object({
  action: z.literal("getTimeRange").describe(
    "Get the minimum and maximum dates from all object time ranges",
  ),
});

const getCountsSchema = z.object({
  action: z.literal("getCounts").describe(
    "Get cached counts per object type. Returns cached values for fast loading.",
  ),
  forceRefresh: z.boolean().optional().describe(
    "If true, recalculate counts from database and update cache",
  ),
});

// EJSON represents JavaScript `undefined` object properties as `null`. Accept
// that wire representation for optional fields while keeping handlers on the
// simpler `undefined` contract. Explicitly nullable domain fields use their own
// schemas and are unaffected.
const ejsonOptional = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

const listCardsSchema = z.object({
  action: z.literal("listCards").describe(
    "List one bounded Objects-page card section with cursor pagination",
  ),
  section: z.enum([...OBJECT_LIST_CATEGORIES, "starred"]),
  filters: ejsonOptional(z.object({
    search: ejsonOptional(z.string().max(200)),
    tagIds: ejsonOptional(
      z.array(
        z.string().refine((value) => ObjectId.isValid(value), {
          message: "Invalid tag ObjectId",
        }),
      ).max(20),
    ),
    tagMode: ejsonOptional(z.enum(["and", "or"])),
    orphanedOnly: ejsonOptional(z.boolean()),
  })),
  sort: ejsonOptional(z.enum(["updatedAt", "createdAt", "name"])),
  cursor: ejsonOptional(z.string().max(2048)),
  limit: ejsonOptional(z.number().int().min(1).max(50)),
});

const repairListCatalogSchema = z.object({
  action: z.literal("repairListCatalog").describe(
    "Backfill one bounded batch of the internal object browse catalog and validate parity at completion",
  ),
  batchSize: z.number().int().min(1).max(1000).nullish().transform((value) =>
    value ?? 1000
  ),
});

const listTagOptionsSchema = z.object({
  action: z.literal("listTagOptions").describe(
    "Read a bounded compact set of tag options for the Objects-page filter",
  ),
  ids: ejsonOptional(
    z.array(
      z.string().refine((value) => ObjectId.isValid(value), {
        message: "Invalid tag ObjectId",
      }),
    ).max(20),
  ),
  search: ejsonOptional(z.string().max(200)),
  limit: z.number().int().min(1).max(50).nullish().transform((value) =>
    value ?? 32
  ),
});

const getDensitySchema = z.object({
  action: z.literal("getDensity").describe(
    "Read bounded persisted object interval-start density for the Timeline",
  ),
  start: zDateOrString(),
  end: zDateOrString(),
  resolution: ejsonOptional(z.enum(OBJECT_DENSITY_RESOLUTIONS)),
  categories: ejsonOptional(
    z.array(z.enum(TIMELINE_OBJECT_CATEGORIES)).max(
      TIMELINE_OBJECT_CATEGORIES.length,
    ),
  ),
});

const mergeObjectsSchema = z.object({
  action: z.literal("merge").describe(
    "Merge duplicate objects into one. Loser names/aliases become winner aliases, all relationship edges are re-pointed to the winner, losers are deleted.",
  ),
  winnerId: z.string().describe(
    "MongoDB ObjectId string of the object that survives",
  ),
  loserIds: z.array(z.string()).min(1).max(20).describe(
    "Ids of objects merged into the winner; they are deleted afterwards",
  ),
  canonicalName: z.string().min(1).optional().describe(
    "Final name for the winner (default: winner's current name). The displaced winner name becomes an alias.",
  ),
  version: z.number().optional().describe(
    "Winner's expected version for optimistic locking; omit to skip the check",
  ),
});

const splitObjectSchema = z.object({
  action: z.literal("split").describe(
    "Split one object into two: create a new object and move selected relationship edges and aliases to it. Used when one object wrongly mixes two real-world entities.",
  ),
  sourceId: z.string().describe(
    "MongoDB ObjectId string of the object to split",
  ),
  newObject: z.object({
    name: z.string().min(1).describe("Name for the new object"),
    details: z.string().nullish().describe(
      "Optional details for the new object",
    ),
    icon: zIcon.optional().describe(
      "Optional icon; defaults to the source's icon",
    ),
    color: z.string().optional().describe(
      "Optional color; defaults to the source's color",
    ),
  }).describe(
    "Fields for the new object; type flags are copied from the source",
  ),
  edgeIdsToMove: z.array(z.string()).default([]).describe(
    "Ids of relationship objects to re-point from the source to the new object",
  ),
  aliasesToMove: z.array(z.string()).default([]).describe(
    "Aliases removed from the source and added to the new object",
  ),
  version: z.number().optional().describe(
    "Source's expected version for optimistic locking; omit to skip the check",
  ),
});

const findDuplicatesSchema = z.object({
  action: z.literal("findDuplicates").describe(
    "Find potential duplicate objects by case-insensitive name/alias collision. With objectId: candidates matching that object. Without: all collision groups.",
  ),
  objectId: z.string().optional().describe(
    "Find duplicates of this specific object; omit to scan the whole collection",
  ),
  limit: z.number().min(1).max(200).default(50).describe(
    "Max candidates (objectId mode) or collision groups (scan mode) to return",
  ),
});

const claimSummarizationSchema = z.object({
  action: z.literal("claimSummarization").describe(
    "Atomically claim conversations for a summarization job. Each candidate is claimed only if it still has no summaries and no fresh claim; returns the ids this job actually won.",
  ),
  ids: z.array(z.string()).max(200).describe(
    "Candidate conversation ObjectId strings",
  ),
  jobId: z.string().describe("Claiming summarization job id"),
  staleBefore: z.string().describe(
    "ISO timestamp; existing claims started before this are stale and reclaimable",
  ),
});

const releaseSummarizationSchema = z.object({
  action: z.literal("releaseSummarization").describe(
    "Release summarization claims held by a job on the given conversations",
  ),
  ids: z.array(z.string()).max(200).describe(
    "Conversation ObjectId strings to release",
  ),
  jobId: z.string().describe(
    "Only claims held by this job id are released",
  ),
});

const objectsRequestSchema = z.discriminatedUnion("action", [
  createObjectSchema,
  updateObjectSchema,
  deleteObjectSchema,
  getObjectSchema,
  listObjectsSchema,
  getRelationshipsSchema,
  getHistorySchema,
  exploreTimeRangeSchema,
  getTimeRangeSchema,
  getCountsSchema,
  listCardsSchema,
  listTagOptionsSchema,
  repairListCatalogSchema,
  getDensitySchema,
  mergeObjectsSchema,
  splitObjectSchema,
  findDuplicatesSchema,
  claimSummarizationSchema,
  releaseSummarizationSchema,
]);

export type ObjectsRequest = z.infer<typeof objectsRequestSchema>;
export type ObjectsResponse = any;

const OBJECT_TYPE_FLAGS: Array<[flag: string, type: string]> = [
  ["isPerson", "person"],
  ["isEvent", "event"],
  ["isRelationship", "relationship"],
  ["isPromise", "promise"],
  ["isConversation", "conversation"],
  ["isTag", "tag"],
  ["isPlace", "place"],
  ["isOrganization", "organization"],
  ["isProduct", "product"],
  ["isProject", "project"],
  ["isAnimal", "animal"],
  ["isConcept", "concept"],
  ["isMedia", "media"],
];

function objectType(doc: any): string {
  for (const [flag, type] of OBJECT_TYPE_FLAGS) {
    if (doc?.[flag]) return type;
  }
  return "object";
}

/**
 * Compact reference to an object for tool results: enough for a consumer
 * (e.g. the chat assistant / UI) to name and link to it without refetching.
 * The url is a frontend-relative path.
 */
function objectRef(
  doc: any,
): { id: string; name: string; type: string; url: string } {
  const id = String(doc._id);
  return { id, name: doc.name, type: objectType(doc), url: `/objects/${id}` };
}

export function stripObjectListInternals(value: any): any {
  if (Array.isArray(value)) return value.map(stripObjectListInternals);
  if (
    value == null || typeof value !== "object" || value instanceof Date ||
    value instanceof ObjectId ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, nested]) =>
      key === "_listCategories" ? [] : [[key, stripObjectListInternals(nested)]]
    ),
  );
}

/**
 * Update values arrive as plain JSON (e.g. from the chat assistant), so date
 * fields inside timeRanges come in as ISO strings. Stored strings crash every
 * consumer that expects Date (frontend calls .getTime()). Revives start/end
 * strings — and bare string values for dotted paths like "timeRanges.0.start"
 * — into Date objects.
 */
export function reviveTimeRangeDates(value: any): any {
  if (Array.isArray(value)) {
    return value.map(reviveTimeRangeDates);
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, any> = { ...value };
    for (const key of ["start", "end"]) {
      if (typeof out[key] === "string" && !Number.isNaN(Date.parse(out[key]))) {
        out[key] = new Date(out[key]);
      }
    }
    return out;
  }
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value);
  }
  return value;
}

function getNestedValue(obj: any, path: string): any {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

export class ObjectsResource
  implements Resource<ObjectsRequest, ObjectsResponse> {
  code = "objects";
  description =
    "Manage timeline objects (people, events, places, relationships, promises). Objects form a graph where relationships connect entities with temporal data. Supports optimistic locking for concurrent updates. Use 'list' to find objects, 'get' for details, 'getRelationships' to explore connections, 'exploreTimeRange' to find objects active during a time period, 'create' for new entities, 'update' for field changes, and 'getHistory' for version tracking.";
  schemas = {
    request: objectsRequestSchema as z.ZodType<ObjectsRequest>,
    response: z.any(),
  };
  private typeCountsRefreshPromise: Promise<void> | null = null;
  private orphanedRefreshPromise: Promise<void> | null = null;

  // Calculate type counts (fast)
  private async refreshTypeCounts(auth: Auth): Promise<{
    person: number;
    event: number;
    relationship: number;
    promise: number;
    conversation: number;
    tag: number;
    place: number;
    organization: number;
    product: number;
    project: number;
    animal: number;
    concept: number;
    media: number;
    other: number;
    total: number;
  }> {
    const mongo = getMongoResource(auth);

    const countsPipeline = [
      {
        $group: {
          _id: null,
          person: { $sum: { $cond: [{ $eq: ["$isPerson", true] }, 1, 0] } },
          event: { $sum: { $cond: [{ $eq: ["$isEvent", true] }, 1, 0] } },
          promise: { $sum: { $cond: [{ $eq: ["$isPromise", true] }, 1, 0] } },
          tag: { $sum: { $cond: [{ $eq: ["$isTag", true] }, 1, 0] } },
          relationship: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$isRelationship", true] },
                    { $ne: ["$isPromise", true] },
                    { $ne: ["$isTag", true] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          conversation: {
            $sum: { $cond: [{ $eq: ["$isConversation", true] }, 1, 0] },
          },
          place: { $sum: { $cond: [{ $eq: ["$isPlace", true] }, 1, 0] } },
          organization: {
            $sum: { $cond: [{ $eq: ["$isOrganization", true] }, 1, 0] },
          },
          product: { $sum: { $cond: [{ $eq: ["$isProduct", true] }, 1, 0] } },
          project: { $sum: { $cond: [{ $eq: ["$isProject", true] }, 1, 0] } },
          animal: { $sum: { $cond: [{ $eq: ["$isAnimal", true] }, 1, 0] } },
          concept: { $sum: { $cond: [{ $eq: ["$isConcept", true] }, 1, 0] } },
          media: { $sum: { $cond: [{ $eq: ["$isMedia", true] }, 1, 0] } },
          other: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$isPerson", true] },
                    { $ne: ["$isEvent", true] },
                    { $ne: ["$isRelationship", true] },
                    { $ne: ["$isPromise", true] },
                    { $ne: ["$isConversation", true] },
                    { $ne: ["$isTag", true] },
                    { $ne: ["$isPlace", true] },
                    { $ne: ["$isOrganization", true] },
                    { $ne: ["$isProduct", true] },
                    { $ne: ["$isProject", true] },
                    { $ne: ["$isAnimal", true] },
                    { $ne: ["$isConcept", true] },
                    { $ne: ["$isMedia", true] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          total: { $sum: 1 },
        },
      },
    ];

    const countsResult = await mongo({
      action: "aggregate",
      collection: "objects",
      pipeline: countsPipeline,
      options: { maxTimeMS: 8_000 },
    });
    const result = countsResult[0] as {
      person: number;
      event: number;
      relationship: number;
      promise: number;
      conversation: number;
      tag: number;
      place: number;
      organization: number;
      product: number;
      project: number;
      animal: number;
      concept: number;
      media: number;
      other: number;
      total: number;
    } | undefined;

    if (result) {
      delete (result as any)._id;
      return result;
    }
    return {
      person: 0,
      event: 0,
      relationship: 0,
      promise: 0,
      conversation: 0,
      tag: 0,
      place: 0,
      organization: 0,
      product: 0,
      project: 0,
      animal: 0,
      concept: 0,
      media: 0,
      other: 0,
      total: 0,
    };
  }

  // Calculate orphaned count with two indexed, non-correlated lookups.
  private async refreshOrphanedCount(auth: Auth): Promise<number> {
    const mongo = getMongoResource(auth);

    const orphanedPipeline = [
      {
        $match: {
          isRelationship: { $ne: true },
        },
      },
      {
        $lookup: {
          from: "objects",
          localField: "_id",
          foreignField: "relationship.subject",
          pipeline: [{ $match: { isRelationship: true } }, { $limit: 1 }],
          as: "subjectReferences",
        },
      },
      {
        $lookup: {
          from: "objects",
          localField: "_id",
          foreignField: "relationship.object",
          pipeline: [{ $match: { isRelationship: true } }, { $limit: 1 }],
          as: "objectReferences",
        },
      },
      {
        $match: {
          subjectReferences: { $size: 0 },
          objectReferences: { $size: 0 },
        },
      },
      { $count: "total" },
    ];

    const orphanedResult = await mongo({
      action: "aggregate",
      collection: "objects",
      pipeline: orphanedPipeline,
      options: { maxTimeMS: 8_000 },
    });
    return orphanedResult[0]?.total ?? 0;
  }

  // Calculate and cache all counts
  private async refreshCounts(auth: Auth): Promise<{
    person: number;
    event: number;
    relationship: number;
    promise: number;
    conversation: number;
    tag: number;
    place: number;
    organization: number;
    product: number;
    project: number;
    animal: number;
    concept: number;
    media: number;
    other: number;
    orphaned: number;
    total: number;
    updatedAt: Date;
  }> {
    const mongo = getMongoResource(auth);

    // Calculate type counts first (fast)
    const typeCounts = await this.refreshTypeCounts(auth);

    // Calculate orphaned count (slow)
    const orphanedCount = await this.refreshOrphanedCount(auth);

    const stats = {
      person: typeCounts.person,
      event: typeCounts.event,
      relationship: typeCounts.relationship,
      promise: typeCounts.promise,
      conversation: typeCounts.conversation,
      tag: typeCounts.tag,
      place: typeCounts.place,
      organization: typeCounts.organization,
      product: typeCounts.product,
      project: typeCounts.project,
      animal: typeCounts.animal,
      concept: typeCounts.concept,
      media: typeCounts.media,
      other: typeCounts.other,
      orphaned: orphanedCount,
      total: typeCounts.total,
      updatedAt: new Date(),
    };

    // Store in cache collection
    await mongo({
      action: "updateOne",
      collection: "object_stats",
      query: { _id: "counts" },
      update: { $set: stats },
      options: { upsert: true },
    });

    return stats;
  }

  // Quick refresh - only type counts, keep existing orphaned from cache
  private async refreshTypeCountsOnly(auth: Auth): Promise<{
    person: number;
    event: number;
    relationship: number;
    promise: number;
    conversation: number;
    tag: number;
    place: number;
    organization: number;
    product: number;
    project: number;
    animal: number;
    concept: number;
    media: number;
    other: number;
    orphaned: number | null;
    total: number;
    updatedAt: Date;
    orphanedLoading?: boolean;
  }> {
    const mongo = getMongoResource(auth);

    // Get existing orphaned count from cache
    const cached = await mongo({
      action: "findOne",
      collection: "object_stats",
      query: { _id: "counts" },
    });
    const existingOrphaned = cached?.orphaned ?? null;

    // Calculate type counts (fast)
    const typeCounts = await this.refreshTypeCounts(auth);

    const stats = {
      person: typeCounts.person,
      event: typeCounts.event,
      relationship: typeCounts.relationship,
      promise: typeCounts.promise,
      conversation: typeCounts.conversation,
      tag: typeCounts.tag,
      place: typeCounts.place,
      organization: typeCounts.organization,
      product: typeCounts.product,
      project: typeCounts.project,
      animal: typeCounts.animal,
      concept: typeCounts.concept,
      media: typeCounts.media,
      other: typeCounts.other,
      orphaned: existingOrphaned,
      total: typeCounts.total,
      updatedAt: new Date(),
      orphanedLoading: existingOrphaned === null,
    };

    // Update cache with type counts, preserve orphaned if exists
    await mongo({
      action: "updateOne",
      collection: "object_stats",
      query: { _id: "counts" },
      update: {
        $set: {
          person: stats.person,
          event: stats.event,
          relationship: stats.relationship,
          promise: stats.promise,
          conversation: stats.conversation,
          tag: stats.tag,
          place: stats.place,
          organization: stats.organization,
          product: stats.product,
          project: stats.project,
          animal: stats.animal,
          concept: stats.concept,
          media: stats.media,
          other: stats.other,
          total: stats.total,
          updatedAt: stats.updatedAt,
          stale: false,
        },
      },
      options: { upsert: true },
    });

    // Calculate orphaned count in background (don't await)
    this.refreshOrphanedCount(auth).then(async (orphaned) => {
      const bgMongo = getMongoResource(auth);
      await bgMongo({
        action: "updateOne",
        collection: "object_stats",
        query: { _id: "counts" },
        update: { $set: { orphaned } },
      });
    }).catch((err) => console.error("Failed to refresh orphaned count:", err));

    return stats;
  }

  // Get cached counts, or calculate if not exists
  private async getCachedCounts(auth: Auth): Promise<
    {
      person: number;
      event: number;
      relationship: number;
      promise: number;
      conversation: number;
      tag: number;
      place: number;
      organization: number;
      product: number;
      project: number;
      animal: number;
      concept: number;
      media: number;
      other: number;
      orphaned: number;
      total: number;
      updatedAt: Date | null;
      stale?: boolean;
    } | null
  > {
    const mongo = getMongoResource(auth);
    const cached = await mongo({
      action: "findOne",
      collection: "object_stats",
      query: { _id: "counts" },
    });
    if (!cached) return null;
    return {
      person: cached.person,
      event: cached.event,
      relationship: cached.relationship,
      promise: cached.promise,
      conversation: cached.conversation,
      tag: cached.tag || 0,
      place: cached.place || 0,
      organization: cached.organization || 0,
      product: cached.product || 0,
      project: cached.project || 0,
      animal: cached.animal || 0,
      concept: cached.concept || 0,
      media: cached.media || 0,
      other: cached.other,
      orphaned: cached.orphaned,
      total: cached.total,
      updatedAt: cached.updatedAt,
      stale: cached.stale,
    };
  }

  private async refreshTypeCountsSingleflight(auth: Auth): Promise<void> {
    if (this.typeCountsRefreshPromise) return this.typeCountsRefreshPromise;
    this.typeCountsRefreshPromise = (async () => {
      const mongo = getMongoResource(auth);
      try {
        const counts = await this.refreshTypeCounts(auth);
        const asOf = new Date();
        await mongo({
          action: "updateOne",
          collection: "object_stats",
          query: { _id: "counts" },
          update: {
            $set: {
              ...counts,
              typeCountsUpdatedAt: asOf,
              typeCountsStatus: "fresh",
              stale: false,
            },
          },
          options: { upsert: true },
        });
      } catch (error) {
        await mongo({
          action: "updateOne",
          collection: "object_stats",
          query: { _id: "counts" },
          update: {
            $set: {
              typeCountsStatus: "stale",
              typeCountsLastErrorAt: new Date(),
              stale: true,
            },
          },
          options: { upsert: true },
        });
        console.error("Failed to refresh object type counts:", error);
      }
    })().finally(() => {
      this.typeCountsRefreshPromise = null;
    });
    return this.typeCountsRefreshPromise;
  }

  private async refreshOrphanedCountSingleflight(
    auth: Auth,
    force = false,
  ): Promise<void> {
    if (this.orphanedRefreshPromise) return this.orphanedRefreshPromise;
    const mongo = getMongoResource(auth);
    this.orphanedRefreshPromise = (async () => {
      if (!force) {
        const cached = await mongo({
          action: "findOne",
          collection: "object_stats",
          query: { _id: "counts" },
        });
        const retryAfter = cached?.orphanedRetryAfter
          ? new Date(cached.orphanedRetryAfter).getTime()
          : 0;
        if (retryAfter > Date.now()) return;
      }
      try {
        const orphaned = await this.refreshOrphanedCount(auth);
        await mongo({
          action: "updateOne",
          collection: "object_stats",
          query: { _id: "counts" },
          update: {
            $set: {
              orphaned,
              orphanedUpdatedAt: new Date(),
              orphanedStatus: "fresh",
            },
            $unset: { orphanedRetryAfter: "" },
          },
          options: { upsert: true },
        });
      } catch (error) {
        const cached = await mongo({
          action: "findOne",
          collection: "object_stats",
          query: { _id: "counts" },
        });
        await mongo({
          action: "updateOne",
          collection: "object_stats",
          query: { _id: "counts" },
          update: {
            $set: {
              orphanedStatus: cached?.orphaned == null
                ? "unavailable"
                : "stale",
              orphanedLastErrorAt: new Date(),
              orphanedRetryAfter: new Date(Date.now() + 60_000),
            },
          },
          options: { upsert: true },
        });
        console.error("Failed to refresh orphaned object count:", error);
      }
    })().finally(() => {
      this.orphanedRefreshPromise = null;
    });
    return this.orphanedRefreshPromise;
  }

  private formatCounts(
    cached: any,
    refreshing: { typeCounts?: boolean; orphaned?: boolean } = {},
  ) {
    const typeAsOf = cached?.typeCountsUpdatedAt ?? cached?.updatedAt ?? null;
    const orphanedAsOf = cached?.orphanedUpdatedAt ?? null;
    const typeStatus = refreshing.typeCounts
      ? "refreshing"
      : cached?.typeCountsStatus ?? (typeAsOf ? "stale" : "unavailable");
    const orphanedStatus = refreshing.orphaned
      ? "refreshing"
      : cached?.orphanedStatus ??
        (cached?.orphaned == null ? "unavailable" : "stale");
    return {
      person: cached?.person ?? 0,
      event: cached?.event ?? 0,
      relationship: cached?.relationship ?? 0,
      promise: cached?.promise ?? 0,
      conversation: cached?.conversation ?? 0,
      tag: cached?.tag ?? 0,
      place: cached?.place ?? 0,
      organization: cached?.organization ?? 0,
      product: cached?.product ?? 0,
      project: cached?.project ?? 0,
      animal: cached?.animal ?? 0,
      concept: cached?.concept ?? 0,
      media: cached?.media ?? 0,
      other: cached?.other ?? 0,
      orphaned: cached?.orphaned ?? null,
      total: cached?.total ?? 0,
      updatedAt: typeAsOf,
      stale: typeStatus !== "fresh",
      orphanedLoading: orphanedStatus === "refreshing" &&
        cached?.orphaned == null,
      meta: {
        typeCounts: { status: typeStatus, asOf: typeAsOf },
        orphaned: { status: orphanedStatus, asOf: orphanedAsOf },
      },
    };
  }

  private async getCountsV2(auth: Auth, forceRefresh = false) {
    const mongo = getMongoResource(auth);
    let cached = await mongo({
      action: "findOne",
      collection: "object_stats",
      query: { _id: "counts" },
    });

    if (forceRefresh) {
      await Promise.all([
        this.refreshTypeCountsSingleflight(auth),
        this.refreshOrphanedCountSingleflight(auth, true),
      ]);
      cached = await mongo({
        action: "findOne",
        collection: "object_stats",
        query: { _id: "counts" },
      });
      return this.formatCounts(cached);
    }

    if (!cached || cached.typeCountsUpdatedAt == null) {
      await this.refreshTypeCountsSingleflight(auth);
      cached = await mongo({
        action: "findOne",
        collection: "object_stats",
        query: { _id: "counts" },
      });
      void this.refreshOrphanedCountSingleflight(auth);
      return this.formatCounts(cached, { orphaned: true });
    }

    const typeAge = Date.now() - new Date(cached.typeCountsUpdatedAt).getTime();
    const orphanedAge = cached.orphanedUpdatedAt
      ? Date.now() - new Date(cached.orphanedUpdatedAt).getTime()
      : Number.POSITIVE_INFINITY;
    const refreshTypes = cached.stale === true ||
      cached.typeCountsStatus !== "fresh" || typeAge >= 60_000;
    const orphanedRetrySuppressed = cached.orphanedRetryAfter &&
      new Date(cached.orphanedRetryAfter).getTime() > Date.now();
    const refreshOrphaned = !orphanedRetrySuppressed &&
      (cached.orphanedStatus !== "fresh" || orphanedAge >= 5 * 60_000);
    if (refreshTypes) void this.refreshTypeCountsSingleflight(auth);
    if (refreshOrphaned) void this.refreshOrphanedCountSingleflight(auth);
    return this.formatCounts(cached, {
      typeCounts: refreshTypes,
      orphaned: refreshOrphaned,
    });
  }

  // Invalidate counts cache (called after create/update/delete)
  private async invalidateCountsCache(auth: Auth): Promise<void> {
    const mongo = getMongoResource(auth);
    // Just mark as stale by updating a flag, don't recalculate immediately
    await mongo({
      action: "updateOne",
      collection: "object_stats",
      query: { _id: "counts" },
      update: {
        $set: {
          stale: true,
          typeCountsStatus: "stale",
          orphanedStatus: "stale",
        },
      },
      options: { upsert: true },
    });
  }

  private async recordHistory(
    auth: Auth,
    objectId: ObjectId,
    action: "create" | "update" | "delete" | "merge" | "split",
    userId: string,
    version: number,
    field: string | null,
    oldValue: any,
    newValue: any,
  ): Promise<void> {
    try {
      const mongo = getMongoResource(auth);
      await mongo({
        action: "insertOne",
        collection: "object_history",
        doc: {
          objectId,
          action,
          timestamp: new Date(),
          userId,
          version,
          field,
          oldValue,
          newValue,
        },
      });
    } catch (error) {
      console.error("Failed to record object history:", error);
    }
  }

  async use(input: ObjectsRequest, caller?: Auth): Promise<ObjectsResponse> {
    return stripObjectListInternals(await this.useInternal(input, caller));
  }

  private async useInternal(input: ObjectsRequest, caller?: Auth): Promise<ObjectsResponse> {
    const auth = await getServerAuth(); // already checked objects permissions
    const actor = caller?.principal ?? auth.principal;
    const mongo = await getMongoResource(auth);

    switch (input.action) {
      case "create": {
        const now = new Date();
        const doc = {
          ...input.object,
          _listCategories: deriveObjectListCategories(input.object),
          _entityTypingPending: deriveEntityTypingPending(input.object),
          version: 1,
          createdAt: now,
          updatedAt: now,
        };

        const result = await mongo({
          action: "insertOne",
          collection: "objects",
          doc,
        });

        await this.recordHistory(
          auth,
          result.insertedId,
          "create",
          actor,
          1,
          null,
          undefined,
          doc,
        );

        // Invalidate counts cache
        await this.invalidateCountsCache(auth);

        return {
          insertedId: result.insertedId,
          ...objectRef({ ...doc, _id: result.insertedId }),
          // Surfaced to tool consumers (e.g. the chat assistant) so an
          // incomplete event gets fixed instead of silently missing from
          // the timeline. The UI allows adding time ranges later.
          ...(input.object.isEvent && !input.object.timeRanges?.length
            ? {
              warning:
                "This event has no timeRanges, so it will not appear on the timeline. Add one with objects_update (field: timeRanges).",
            }
            : {}),
        };
      }

      case "get": {
        const objectId = new ObjectId(input.id as string);
        const object = await mongo({
          action: "findOne",
          collection: "objects",
          query: { _id: objectId },
        });
        if (!object) {
          // Tombstone: if history shows the object was deleted (directly or
          // by a merge), report that instead of a bare error so consumers
          // can say when/by whom it was deleted and link to the merge winner.
          const history = await mongo({
            action: "find",
            collection: "object_history",
            query: {
              objectId,
              $or: [{ action: "delete" }, {
                action: "merge",
                field: "mergedInto",
              }],
            },
            options: { sort: { timestamp: -1 }, limit: 1 },
          });
          const deletion = history?.[0];
          if (deletion) {
            const lastKnown = deletion.oldValue ?? {};
            return {
              _id: objectId,
              deleted: true,
              deletedAt: deletion.timestamp,
              deletedBy: deletion.userId,
              name: lastKnown.name,
              type: objectType(lastKnown),
              ...(deletion.field === "mergedInto" && deletion.newValue
                ? { mergedInto: String(deletion.newValue) }
                : {}),
              lastKnown,
            };
          }
          const error: any = new Error("Object not found");
          error.code = 404;
          throw error;
        }
        if (object.version === undefined) {
          object.version = 0;
        }
        return object;
      }

      case "update": {
        const objectId = new ObjectId(input.id as string);

        const current = await mongo({
          action: "findOne",
          collection: "objects",
          query: { _id: objectId },
        });
        if (!current) {
          throw new Error("Object not found");
        }

        const currentVersion = current.version ?? 0;

        if (currentVersion !== input.version) {
          const error: any = new Error("Object was modified by another user");
          error.code = 409;
          error.current = currentVersion;
          error.expected = input.version;
          error.latestObject = { ...current, version: currentVersion };
          throw error;
        }

        const oldValue = getNestedValue(current, input.field);

        // Date fields must be stored as Dates, not the ISO strings JSON
        // callers send
        if (
          input.field === "timeRanges" || input.field.startsWith("timeRanges")
        ) {
          input.value = reviveTimeRangeDates(input.value);
        }

        // If value is null, use $unset to remove the field, otherwise use $set
        const updateDoc: any = {};

        if (input.value === null || input.value === undefined) {
          // Remove the field using $unset, but still update version
          updateDoc.$unset = { [input.field]: "" };
          updateDoc.$set = {
            version: currentVersion + 1,
          };
        } else {
          // Set the field value using $set
          updateDoc.$set = {
            [input.field]: input.value,
            version: currentVersion + 1,
          };
        }

        const typeFields = OBJECT_LIST_TYPE_FLAGS.map(([flag]) => flag);
        if (
          typeFields.includes(input.field) || input.field === "name" ||
          input.field === "metadata.aiProvenance.entityTyping"
        ) {
          const next = { ...current };
          if (input.value === null || input.value === undefined) {
            delete next[input.field];
          } else {
            next[input.field] = input.value;
          }
          updateDoc.$set._listCategories = deriveObjectListCategories(next);
          updateDoc.$set._entityTypingPending = deriveEntityTypingPending(next);
        }

        await mongo({
          action: "updateOne",
          collection: "objects",
          query: { _id: objectId },
          update: updateDoc,
        });

        const result = await mongo({
          action: "findOne",
          collection: "objects",
          query: { _id: objectId },
        });

        if (!result) {
          const error: any = new Error("Update failed");
          error.code = 500;
          throw error;
        }

        await this.recordHistory(
          auth,
          objectId,
          "update",
          actor,
          result.version,
          input.field,
          oldValue,
          input.value,
        );

        // Invalidate counts cache if type-related fields changed
        if (
          typeFields.includes(input.field) ||
          input.field.startsWith("relationship")
        ) {
          await this.invalidateCountsCache(auth);
        }

        // The updated document itself (cached as-is by the frontend), plus
        // reference fields so tool consumers can link to it.
        return { ...result, ...objectRef(result) };
      }

      case "delete": {
        const objectId = new ObjectId(input.id as string);

        const current = await mongo({
          action: "findOne",
          collection: "objects",
          query: { _id: objectId },
        });
        if (!current) {
          throw new Error("Object not found");
        }

        const result = await mongo({
          action: "deleteOne",
          collection: "objects",
          query: { _id: objectId },
        });

        await this.recordHistory(
          auth,
          objectId,
          "delete",
          actor,
          current.version ?? 0,
          null,
          current,
          undefined,
        );

        // Invalidate counts cache
        await this.invalidateCountsCache(auth);

        return {
          deletedCount: result.deletedCount,
          id: input.id,
          name: current.name,
          type: objectType(current),
        };
      }

      case "merge": {
        const winnerId = new ObjectId(input.winnerId);
        const loserIds = [...new Set(input.loserIds)];
        if (loserIds.includes(input.winnerId)) {
          throw new Error("Winner cannot be one of the merged objects");
        }
        const loserObjectIds = loserIds.map((id) => new ObjectId(id));

        const docs = await mongo({
          action: "find",
          collection: "objects",
          query: { _id: { $in: [winnerId, ...loserObjectIds] } },
        });
        const byId = new Map<string, any>(
          docs.map((doc: any) => [doc._id.toString(), doc]),
        );
        const winner = byId.get(input.winnerId);
        if (!winner) {
          throw new Error("Winner object not found");
        }
        const missing = loserIds.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          throw new Error(`Objects not found: ${missing.join(", ")}`);
        }
        const losers = loserIds.map((id) => byId.get(id));
        for (const doc of [winner, ...losers]) {
          if (doc.isRelationship || doc.isConversation) {
            throw new Error(
              "Merging relationship or conversation objects is not supported",
            );
          }
        }
        if (
          input.version !== undefined &&
          (winner.version ?? 0) !== input.version
        ) {
          const error: any = new Error("Object was modified by another user");
          error.code = 409;
          error.current = winner.version ?? 0;
          error.expected = input.version;
          error.latestObject = { ...winner, version: winner.version ?? 0 };
          throw error;
        }

        // No transactions available: steps are ordered so that a crash at any
        // point loses no data, and re-running the same merge completes it.

        // M1: merge fields into the winner.
        const canonical = input.canonicalName ?? winner.name;
        const aliasMap = new Map<string, string>();
        const aliasCandidates = [
          ...(winner.aliases ?? []),
          ...(canonical !== winner.name && winner.name ? [winner.name] : []),
          ...losers.flatMap((l: any) => [l.name, ...(l.aliases ?? [])]),
        ];
        for (const alias of aliasCandidates) {
          if (!alias || typeof alias !== "string") continue;
          const key = alias.toLowerCase();
          if (key === String(canonical).toLowerCase()) continue;
          if (!aliasMap.has(key)) aliasMap.set(key, alias);
        }

        const detailParts = [
          winner.details,
          ...losers.map((l: any) => l.details),
        ]
          .filter((d, i, arr) => d && arr.indexOf(d) === i);

        const rangeKey = (r: any) =>
          JSON.stringify([
            new Date(r.start).toISOString(),
            r.end ? new Date(r.end).toISOString() : null,
            r.name ?? null,
          ]);
        const timeRanges = [
          ...(winner.timeRanges ?? []),
          ...losers.flatMap((l: any) => l.timeRanges ?? []),
        ].filter((r, i, arr) =>
          arr.findIndex((x) => rangeKey(x) === rangeKey(r)) === i
        );

        // Winner's platform identities win on conflict.
        const messenger = {
          ...losers.reduce(
            (acc: any, l: any) => ({ ...acc, ...(l.messenger ?? {}) }),
            {},
          ),
          ...(winner.messenger ?? {}),
        };

        const priorMergedFrom: any[] = winner.metadata?.mergedFrom ?? [];
        const priorMergedIds = new Set(
          priorMergedFrom.map((entry: any) => String(entry.id)),
        );
        const $set: any = {
          name: canonical,
          aliases: [...aliasMap.values()],
          starred: Boolean(
            winner.starred || losers.some((l: any) => l.starred),
          ),
          version: (winner.version ?? 0) + 1,
          "metadata.mergedFrom": [
            ...priorMergedFrom,
            ...losers
              .filter((l: any) => !priorMergedIds.has(l._id.toString()))
              .map((l: any) => ({
                id: l._id,
                name: l.name,
                mergedAt: new Date(),
                by: actor,
              })),
          ],
        };
        const mergeableFlags = [
          "isPerson",
          "isEvent",
          "isTag",
          "isPlace",
          "isOrganization",
          "isProduct",
          "isProject",
          "isAnimal",
          "isConcept",
          "isMedia",
        ];
        for (const flag of mergeableFlags) {
          if (winner[flag] || losers.some((l: any) => l[flag])) {
            $set[flag] = true;
          }
        }
        $set._listCategories = deriveObjectListCategories({
          ...winner,
          ...$set,
        });
        $set._entityTypingPending = deriveEntityTypingPending({
          ...winner,
          ...$set,
        });
        if (detailParts.length) $set.details = detailParts.join("\n\n---\n\n");
        if (timeRanges.length) $set.timeRanges = timeRanges;
        if (Object.keys(messenger).length) $set.messenger = messenger;
        if (!winner.icon) {
          const withIcon = losers.find((l: any) => l.icon);
          if (withIcon) $set.icon = withIcon.icon;
        }
        if (!winner.color) {
          const withColor = losers.find((l: any) => l.color);
          if (withColor) $set.color = withColor.color;
        }
        if (!winner.location) {
          const withLocation = losers.find((l: any) => l.location);
          if (withLocation) $set.location = withLocation.location;
        }
        const mergedSummaries = [
          ...(winner.summaries ?? []),
          ...losers.flatMap((l: any) => l.summaries ?? []),
        ];
        if (mergedSummaries.length) $set.summaries = mergedSummaries;

        await mongo({
          action: "updateOne",
          collection: "objects",
          query: { _id: winnerId },
          update: { $set },
        });

        // M2: re-point all relationship edges from losers to the winner.
        const subjectResult = await mongo({
          action: "updateMany",
          collection: "objects",
          query: {
            isRelationship: true,
            "relationship.subject": { $in: loserObjectIds },
          },
          update: { $set: { "relationship.subject": winnerId } },
        });
        const objectResult = await mongo({
          action: "updateMany",
          collection: "objects",
          query: {
            isRelationship: true,
            "relationship.object": { $in: loserObjectIds },
          },
          update: { $set: { "relationship.object": winnerId } },
        });

        // M3: drop self-edges, then collapse duplicate edges (same name +
        // endpoints) that re-pointing may have produced. Oldest edge wins.
        await mongo({
          action: "deleteMany",
          collection: "objects",
          query: {
            isRelationship: true,
            "relationship.subject": winnerId,
            "relationship.object": winnerId,
          },
        });
        const dupGroups = await mongo({
          action: "aggregate",
          collection: "objects",
          pipeline: [
            {
              $match: {
                isRelationship: true,
                $or: [
                  { "relationship.subject": winnerId },
                  { "relationship.object": winnerId },
                ],
              },
            },
            { $sort: { createdAt: 1, _id: 1 } },
            {
              $group: {
                _id: {
                  name: "$name",
                  subject: "$relationship.subject",
                  object: "$relationship.object",
                },
                ids: { $push: "$_id" },
                count: { $sum: 1 },
              },
            },
            { $match: { count: { $gt: 1 } } },
          ],
        });
        const duplicateEdgeIds = dupGroups.flatMap((group: any) =>
          group.ids.slice(1)
        );
        if (duplicateEdgeIds.length > 0) {
          await mongo({
            action: "deleteMany",
            collection: "objects",
            query: { _id: { $in: duplicateEdgeIds } },
          });
        }

        // M4: re-point message senders (person merges).
        const messagesResult = await mongo({
          action: "updateMany",
          collection: "messages",
          query: { senderId: { $in: loserObjectIds } },
          update: { $set: { senderId: winnerId } },
        });

        // M5: history — full loser docs are preserved here before deletion.
        await this.recordHistory(
          auth,
          winnerId,
          "merge",
          actor,
          (winner.version ?? 0) + 1,
          null,
          winner,
          { mergedFrom: loserIds, canonicalName: canonical },
        );
        for (const loser of losers) {
          await this.recordHistory(
            auth,
            loser._id,
            "merge",
            actor,
            loser.version ?? 0,
            "mergedInto",
            loser,
            winnerId,
          );
        }

        // M6: delete the losers.
        await mongo({
          action: "deleteMany",
          collection: "objects",
          query: { _id: { $in: loserObjectIds } },
        });

        // M7: refresh counts and return the merged winner.
        await this.invalidateCountsCache(auth);
        const mergedWinner = await mongo({
          action: "findOne",
          collection: "objects",
          query: { _id: winnerId },
        });
        return {
          ...objectRef(mergedWinner),
          winner: mergedWinner,
          mergedIds: loserIds,
          edgesRepointed: (subjectResult.modifiedCount ?? 0) +
            (objectResult.modifiedCount ?? 0),
          edgesDeduped: duplicateEdgeIds.length,
          messagesUpdated: messagesResult.modifiedCount ?? 0,
        };
      }

      case "split": {
        const sourceId = new ObjectId(input.sourceId);
        const source = await mongo({
          action: "findOne",
          collection: "objects",
          query: { _id: sourceId },
        });
        if (!source) {
          throw new Error("Source object not found");
        }
        if (source.isRelationship || source.isConversation) {
          throw new Error(
            "Splitting relationship or conversation objects is not supported",
          );
        }
        if (
          input.version !== undefined &&
          (source.version ?? 0) !== input.version
        ) {
          const error: any = new Error("Object was modified by another user");
          error.code = 409;
          error.current = source.version ?? 0;
          error.expected = input.version;
          error.latestObject = { ...source, version: source.version ?? 0 };
          throw error;
        }

        const edgeObjectIds = input.edgeIdsToMove.map((id) => new ObjectId(id));
        const edges = edgeObjectIds.length > 0
          ? await mongo({
            action: "find",
            collection: "objects",
            query: { _id: { $in: edgeObjectIds } },
          })
          : [];
        const edgeById = new Map<string, any>(
          edges.map((edge: any) => [edge._id.toString(), edge]),
        );
        for (const id of input.edgeIdsToMove) {
          const edge = edgeById.get(id);
          if (!edge) {
            throw new Error(`Relationship ${id} not found`);
          }
          if (!edge.isRelationship || !edge.relationship) {
            throw new Error(`Object ${id} is not a relationship`);
          }
          const touchesSource =
            String(edge.relationship.subject) === input.sourceId ||
            String(edge.relationship.object) === input.sourceId;
          if (!touchesSource) {
            throw new Error(
              `Relationship ${id} does not involve the source object`,
            );
          }
        }

        const sourceAliases: string[] = source.aliases ?? [];
        const aliasesToMove = input.aliasesToMove.filter((alias) =>
          sourceAliases.includes(alias)
        );

        const splitFlags = [
          "isPerson",
          "isEvent",
          "isTag",
          "isPlace",
          "isOrganization",
          "isProduct",
          "isProject",
          "isAnimal",
          "isConcept",
          "isMedia",
        ];
        const newDoc: any = {
          name: input.newObject.name,
          ...(input.newObject.details
            ? { details: input.newObject.details }
            : {}),
          ...(input.newObject.icon
            ? { icon: input.newObject.icon }
            : source.icon
            ? { icon: source.icon }
            : {}),
          ...(input.newObject.color
            ? { color: input.newObject.color }
            : source.color
            ? { color: source.color }
            : {}),
          ...(aliasesToMove.length ? { aliases: aliasesToMove } : {}),
          ...Object.fromEntries(
            splitFlags.filter((flag) => source[flag]).map((
              flag,
            ) => [flag, true]),
          ),
          metadata: {
            splitFrom: {
              id: sourceId,
              name: source.name,
              at: new Date(),
              by: actor,
            },
          },
          version: 1,
          createdAt: new Date(),
        };
        newDoc._listCategories = deriveObjectListCategories(newDoc);
        newDoc._entityTypingPending = deriveEntityTypingPending(newDoc);

        const insertResult = await mongo({
          action: "insertOne",
          collection: "objects",
          doc: newDoc,
        });
        const newId = insertResult.insertedId;

        await this.recordHistory(
          auth,
          newId,
          "split",
          actor,
          1,
          null,
          undefined,
          newDoc,
        );

        // Re-point the selected edges — whichever side(s) reference the source.
        const operations = input.edgeIdsToMove.map((id) => {
          const edge = edgeById.get(id);
          const edgeSet: any = {};
          if (String(edge.relationship.subject) === input.sourceId) {
            edgeSet["relationship.subject"] = newId;
          }
          if (String(edge.relationship.object) === input.sourceId) {
            edgeSet["relationship.object"] = newId;
          }
          return {
            updateOne: {
              filter: { _id: edge._id },
              update: { $set: edgeSet },
            },
          };
        });
        if (operations.length > 0) {
          await mongo({
            action: "bulkWrite",
            collection: "objects",
            operations,
          });
        }

        // Remove moved aliases from the source and bump its version.
        const sourceUpdate: any = {
          $set: { version: (source.version ?? 0) + 1 },
        };
        if (aliasesToMove.length > 0) {
          sourceUpdate.$pull = { aliases: { $in: aliasesToMove } };
        }
        await mongo({
          action: "updateOne",
          collection: "objects",
          query: { _id: sourceId },
          update: sourceUpdate,
        });

        await this.recordHistory(
          auth,
          sourceId,
          "split",
          actor,
          (source.version ?? 0) + 1,
          "splitInto",
          undefined,
          {
            newId,
            movedEdgeIds: input.edgeIdsToMove,
            movedAliases: aliasesToMove,
          },
        );

        await this.invalidateCountsCache(auth);
        const updatedSource = await mongo({
          action: "findOne",
          collection: "objects",
          query: { _id: sourceId },
        });
        return {
          newId,
          newObjectRef: objectRef({ ...newDoc, _id: newId }),
          sourceRef: objectRef(updatedSource),
          movedEdges: operations.length,
          movedAliases: aliasesToMove,
          source: updatedSource,
        };
      }

      case "findDuplicates": {
        const limit = input.limit ?? 50;

        if (input.objectId) {
          const targetId = new ObjectId(input.objectId);
          const target = await mongo({
            action: "findOne",
            collection: "objects",
            query: { _id: targetId },
          });
          if (!target) {
            throw new Error("Object not found");
          }
          const keys = [target.name, ...(target.aliases ?? [])]
            .filter((value: unknown): value is string =>
              typeof value === "string" && value.trim().length > 0
            )
            .map((value) => value.trim().toLowerCase());
          if (keys.length === 0) {
            return { candidates: [] };
          }

          const candidates = await mongo({
            action: "aggregate",
            collection: "objects",
            pipeline: [
              {
                $match: {
                  _id: { $ne: targetId },
                  isRelationship: { $ne: true },
                  isConversation: { $ne: true },
                },
              },
              {
                $addFields: {
                  _nameKeys: {
                    $map: {
                      input: {
                        $concatArrays: [
                          [{ $ifNull: ["$name", ""] }],
                          { $ifNull: ["$aliases", []] },
                        ],
                      },
                      as: "value",
                      in: { $toLower: { $trim: { input: "$$value" } } },
                    },
                  },
                },
              },
              {
                $match: {
                  _nameKeys: { $in: keys },
                },
              },
              {
                $project: {
                  name: 1,
                  aliases: 1,
                  details: 1,
                  icon: 1,
                  version: 1,
                  isPerson: 1,
                  isEvent: 1,
                  isPromise: 1,
                  isTag: 1,
                  isPlace: 1,
                  isOrganization: 1,
                  isProduct: 1,
                  isProject: 1,
                  isAnimal: 1,
                  isConcept: 1,
                  isMedia: 1,
                },
              },
              { $limit: limit },
            ],
          });
          return { candidates };
        }

        // Scan mode: group all non-edge objects by lowercase name/alias keys.
        const groups = await mongo({
          action: "aggregate",
          collection: "objects",
          pipeline: [
            {
              $match: {
                isRelationship: { $ne: true },
                isConversation: { $ne: true },
                name: { $exists: true, $ne: "" },
              },
            },
            {
              $project: {
                name: 1,
                aliases: 1,
                icon: 1,
                version: 1,
                isPerson: 1,
                isEvent: 1,
                isPromise: 1,
                isTag: 1,
                isPlace: 1,
                isOrganization: 1,
                isProduct: 1,
                isProject: 1,
                isAnimal: 1,
                isConcept: 1,
                isMedia: 1,
                _nameKeys: {
                  $setUnion: [
                    {
                      $map: {
                        input: {
                          $concatArrays: [
                            ["$name"],
                            { $ifNull: ["$aliases", []] },
                          ],
                        },
                        as: "value",
                        in: { $toLower: { $trim: { input: "$$value" } } },
                      },
                    },
                    [],
                  ],
                },
              },
            },
            { $unwind: "$_nameKeys" },
            { $match: { _nameKeys: { $ne: "" } } },
            {
              $group: {
                _id: "$_nameKeys",
                objects: {
                  $push: {
                    _id: "$_id",
                    name: "$name",
                    aliases: "$aliases",
                    icon: "$icon",
                    version: "$version",
                    isPerson: "$isPerson",
                    isEvent: "$isEvent",
                    isPromise: "$isPromise",
                    isTag: "$isTag",
                    isPlace: "$isPlace",
                    isOrganization: "$isOrganization",
                    isProduct: "$isProduct",
                    isProject: "$isProject",
                    isAnimal: "$isAnimal",
                    isConcept: "$isConcept",
                    isMedia: "$isMedia",
                  },
                },
                count: { $sum: 1 },
              },
            },
            { $match: { count: { $gt: 1 } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: limit },
            {
              $project: {
                _id: 0,
                key: "$_id",
                count: 1,
                objects: 1,
              },
            },
          ],
        });
        return { groups };
      }

      case "claimSummarization": {
        const candidateIds = input.ids.map((id) => new ObjectId(id));
        // Per-document atomicity of updateMany guarantees each conversation
        // is won by exactly one concurrent job.
        await mongo({
          action: "updateMany",
          collection: "objects",
          query: {
            _id: { $in: candidateIds },
            // Same eligibility predicate as the worker's candidate query.
            "summaries.0.date": { $exists: false },
            $or: [
              { _summarizationClaim: { $exists: false } },
              { _summarizationClaim: null },
              { "_summarizationClaim.startedAt": { $lte: input.staleBefore } },
            ],
          },
          update: {
            $set: {
              _summarizationClaim: {
                jobId: input.jobId,
                startedAt: new Date().toISOString(),
              },
            },
          },
        });
        const won = await mongo({
          action: "find",
          collection: "objects",
          query: {
            _id: { $in: candidateIds },
            "_summarizationClaim.jobId": input.jobId,
          },
        });
        return { claimed: (won ?? []).map((d: any) => String(d._id)) };
      }

      case "releaseSummarization": {
        const releaseIds = input.ids.map((id) => new ObjectId(id));
        const result = await mongo({
          action: "updateMany",
          collection: "objects",
          query: {
            _id: { $in: releaseIds },
            "_summarizationClaim.jobId": input.jobId,
          },
          update: { $unset: { _summarizationClaim: "" } },
        });
        return { released: result?.modifiedCount ?? 0 };
      }

      case "listCards": {
        const catalogReady = await isObjectListCatalogReady(mongo);
        return await listObjectCards(mongo, input, catalogReady);
      }

      case "listTagOptions": {
        const catalogReady = await isObjectListCatalogReady(mongo);
        return await listTagOptions(mongo, input, catalogReady);
      }

      case "repairListCatalog": {
        return await repairObjectListCatalog(mongo, input.batchSize);
      }

      case "getDensity": {
        return await getObjectTimelineDensity(input);
      }

      case "list": {
        let query = input.filters || {};

        if (input.options?.hasTimeRanges) {
          query = {
            ...query,
            timeRanges: { $exists: true, $ne: [] },
          };
        }

        if (input.options?.searchTerm && input.options.searchTerm.trim()) {
          const searchRegex = {
            $regex: input.options.searchTerm,
            $options: "i",
          };
          query = {
            ...query,
            $or: [
              { name: searchRegex },
              { aliases: searchRegex },
            ],
          };
        }

        if (input.options?.timeRangeFilter) {
          const filterStart = new Date(input.options.timeRangeFilter.start);
          const filterEnd = new Date(input.options.timeRangeFilter.end);

          query = {
            ...query,
            timeRanges: {
              $elemMatch: {
                start: { $lt: filterEnd },
                $or: [
                  { end: { $gt: filterStart } },
                  { end: { $exists: false } },
                ],
              },
            },
          };
        }

        if (input.options?.includeRelationships) {
          if (input.view === "timeline") {
            const limit = resolveTimelineObjectLimit(input.options?.limit);
            const rows = await mongo({
              action: "aggregate",
              collection: "objects",
              pipeline: buildTimelineObjectsPipeline(
                query,
                input.options?.sort,
                limit,
              ),
              options: {
                allowDiskUse: true,
                hint: TIMELINE_OBJECT_RANGE_INDEX,
                maxTimeMS: TIMELINE_OBJECT_MAX_TIME_MS,
              },
            });

            return {
              objects: rows.slice(0, limit),
              truncated: rows.length > limit,
            };
          }

          const pipeline: any[] = [
            {
              $addFields: {
                hasTimeRanges: {
                  $cond: {
                    if: { $isArray: "$timeRanges" },
                    then: true,
                    else: false,
                  },
                },
              },
            },
            { $match: query },
            {
              $lookup: {
                from: "objects",
                localField: "relationship.subject",
                foreignField: "_id",
                as: "subjectObject",
              },
            },
            {
              $lookup: {
                from: "objects",
                localField: "relationship.object",
                foreignField: "_id",
                as: "objectObject",
              },
            },
            {
              $unwind: {
                path: "$subjectObject",
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $unwind: {
                path: "$objectObject",
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $addFields: {
                earliestStart: {
                  $min: {
                    $map: {
                      input: "$timeRanges",
                      as: "r",
                      in: "$$r.start",
                    },
                  },
                },
                latestEnd: {
                  $max: {
                    $map: {
                      input: "$timeRanges",
                      as: "r",
                      in: { $ifNull: ["$$r.end", "$$r.start"] },
                    },
                  },
                },
              },
            },
            {
              $addFields: {
                duration: { $subtract: ["$latestEnd", "$earliestStart"] },
              },
            },
          ];

          if (input.options?.sort) {
            pipeline.push({ $sort: input.options.sort });
          }

          if (input.options?.skip) {
            pipeline.push({ $skip: input.options.skip });
          }

          if (input.options?.limit) {
            pipeline.push({ $limit: input.options.limit });
          }

          return await mongo({
            action: "aggregate",
            collection: "objects",
            pipeline,
          });
        }

        const findOptions: any = {};
        if (input.options?.sort) {
          findOptions.sort = input.options.sort;
        }
        if (input.options?.skip) {
          findOptions.skip = input.options.skip;
        }
        if (input.options?.limit) {
          findOptions.limit = input.options.limit;
        }

        return await mongo({
          action: "find",
          collection: "objects",
          query,
          options: findOptions,
        });
      }

      case "getRelationships": {
        const objectId = new ObjectId(input.id as string);

        const pipeline = [
          { $match: { isRelationship: true } },
          {
            $match: {
              $or: [
                { "relationship.subject": objectId },
                { "relationship.object": objectId },
              ],
            },
          },
          {
            $lookup: {
              from: "objects",
              localField: "relationship.subject",
              foreignField: "_id",
              as: "subjectObj",
            },
          },
          {
            $lookup: {
              from: "objects",
              localField: "relationship.object",
              foreignField: "_id",
              as: "objectObj",
            },
          },
          {
            $unwind: { path: "$subjectObj", preserveNullAndEmptyArrays: true },
          },
          { $unwind: { path: "$objectObj", preserveNullAndEmptyArrays: true } },
          {
            $project: {
              relationship: "$$ROOT",
              other: {
                $cond: [
                  { $eq: ["$relationship.subject", objectId] },
                  "$objectObj",
                  "$subjectObj",
                ],
              },
            },
          },
          {
            $set: {
              earliestStart: {
                $min: {
                  $map: {
                    input: "$relationship.timeRanges",
                    as: "r",
                    in: "$$r.start",
                  },
                },
              },
              latestEnd: {
                $max: {
                  $map: {
                    input: "$relationship.timeRanges",
                    as: "r",
                    in: "$$r.end",
                  },
                },
              },
            },
          },
          {
            $set: {
              endOrNow: { $ifNull: ["$latestEnd", new Date()] },
            },
          },
          {
            $set: {
              duration: { $subtract: ["$endOrNow", "$earliestStart"] },
            },
          },
          { $sort: { endOrNow: -1, earliestStart: -1 } },
        ];

        return await mongo({
          action: "aggregate",
          collection: "objects",
          pipeline,
        });
      }

      case "getHistory": {
        const objectId = new ObjectId(input.id as string);

        const findOptions: any = {
          sort: { timestamp: -1 },
        };
        if (input.skip != null) {
          findOptions.skip = input.skip;
        }
        findOptions.limit = input.limit ?? 50;

        try {
          return await mongo({
            action: "find",
            collection: "object_history",
            query: { objectId: objectId },
            options: findOptions,
          });
        } catch (error) {
          console.error("Error fetching object history:", error);
          throw new Error(
            `Failed to fetch object history: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      case "exploreTimeRange": {
        console.log(
          "[exploreTimeRange] Input:",
          JSON.stringify(
            {
              start: input.start,
              end: input.end,
              filters: input.filters,
              options: input.options,
              startType: typeof input.start,
              endType: typeof input.end,
            },
            null,
            2,
          ),
        );

        const timeRangeQuery = {
          timeRanges: {
            $elemMatch: {
              start: { $lte: input.end },
              $or: [
                { end: { $gte: input.start } },
                { end: null },
              ],
            },
          },
        };

        const query = input.filters
          ? { ...input.filters, ...timeRangeQuery }
          : timeRangeQuery;

        console.log(
          "[exploreTimeRange] Constructed query:",
          JSON.stringify(query, null, 2),
        );

        if (input.options?.includeRelationships) {
          const pipeline: any[] = [
            { $match: query },
            {
              $lookup: {
                from: "objects",
                localField: "relationship.subject",
                foreignField: "_id",
                as: "subjectObject",
              },
            },
            {
              $lookup: {
                from: "objects",
                localField: "relationship.object",
                foreignField: "_id",
                as: "objectObject",
              },
            },
            {
              $unwind: {
                path: "$subjectObject",
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $unwind: {
                path: "$objectObject",
                preserveNullAndEmptyArrays: true,
              },
            },
          ];

          // Add computed field for sorting by min timeRanges.start
          pipeline.push({
            $addFields: {
              _minTimeRangeStart: { $min: "$timeRanges.start" },
            },
          });

          // Sort by min timeRanges.start (default) or user-specified sort
          pipeline.push({
            $sort: input.options?.sort || { _minTimeRangeStart: 1 },
          });

          if (input.options?.skip) {
            pipeline.push({ $skip: input.options.skip });
          }

          if (input.options?.limit) {
            pipeline.push({ $limit: input.options.limit });
          }

          // Default projection for aggregation - include joined objects (excludes _minTimeRangeStart)
          pipeline.push({
            $project: {
              _id: 1,
              name: 1,
              icon: 1,
              timeRanges: 1,
              summaries: {
                $map: { input: "$summaries", as: "s", in: "$$s.text" },
              },
              isEvent: 1,
              isPerson: 1,
              isRelationship: 1,
              isConversation: 1,
              isPromise: 1,
              subjectObject: { _id: 1, name: 1, icon: 1 },
              objectObject: { _id: 1, name: 1, icon: 1 },
            },
          });

          // Get total count first
          const countResult = await mongo({
            action: "aggregate",
            collection: "objects",
            pipeline: [{ $match: query }, { $count: "total" }],
          });
          const total = countResult?.[0]?.total || 0;

          const objects = await mongo({
            action: "aggregate",
            collection: "objects",
            pipeline,
          });

          console.log(
            "[exploreTimeRange] Aggregate result - total:",
            total,
            "returned:",
            objects?.length,
          );
          return { total, objects };
        }

        // Use aggregation for proper sorting by min timeRanges.start
        const pipeline: any[] = [
          { $match: query },
          { $addFields: { _minTimeRangeStart: { $min: "$timeRanges.start" } } },
          { $sort: input.options?.sort || { _minTimeRangeStart: 1 } },
        ];

        if (input.options?.skip) {
          pipeline.push({ $skip: input.options.skip });
        }
        if (input.options?.limit) {
          pipeline.push({ $limit: input.options.limit });
        }

        // Default projection - excludes _minTimeRangeStart
        pipeline.push({
          $project: {
            _id: 1,
            name: 1,
            icon: 1,
            timeRanges: 1,
            summaries: {
              $map: { input: "$summaries", as: "s", in: "$$s.text" },
            },
            isEvent: 1,
            isPerson: 1,
            isRelationship: 1,
            isConversation: 1,
            isPromise: 1,
          },
        });

        console.log(
          "[exploreTimeRange] Pipeline:",
          JSON.stringify(pipeline, null, 2),
        );

        // Get total count first
        const countResult = await mongo({
          action: "aggregate",
          collection: "objects",
          pipeline: [{ $match: query }, { $count: "total" }],
        });
        const total = countResult?.[0]?.total || 0;

        const objects = await mongo({
          action: "aggregate",
          collection: "objects",
          pipeline,
        });

        console.log(
          "[exploreTimeRange] Result - total:",
          total,
          "returned:",
          objects?.length,
        );

        return { total, objects };
      }

      case "getTimeRange": {
        const pipeline = [
          {
            $match: {
              timeRanges: { $exists: true, $ne: [] },
            },
          },
          {
            $unwind: "$timeRanges",
          },
          {
            $group: {
              _id: null,
              minStart: { $min: "$timeRanges.start" },
              maxEnd: {
                $max: {
                  $ifNull: ["$timeRanges.end", "$timeRanges.start"],
                },
              },
            },
          },
        ];

        const result = await mongo({
          action: "aggregate",
          collection: "objects",
          pipeline,
        });

        if (result && result.length > 0) {
          return {
            start: result[0].minStart,
            end: result[0].maxEnd,
          };
        }

        return { start: null, end: null };
      }

      case "getCounts": {
        return await this.getCountsV2(auth, input.forceRefresh === true);
      }

      default:
        throw new Error("Unknown action");
    }
  }

  extractActions(input: ObjectsRequest) {
    const actionMap: Record<string, string[]> = {
      create: ["create"],
      get: ["read"],
      list: ["read"],
      listCards: ["read"],
      listTagOptions: ["read"],
      repairListCatalog: ["update"],
      getDensity: ["read"],
      update: ["update"],
      delete: ["delete"],
      getRelationships: ["read"],
      getHistory: ["read"],
      exploreTimeRange: ["read"],
      getTimeRange: ["read"],
      getCounts: ["read"],
      merge: ["update", "delete"],
      split: ["create", "update"],
      findDuplicates: ["read"],
    };

    return [
      {
        path: ["objects"],
        actions: actionMap[input.action] || ["read"],
      },
    ];
  }
}

export function getObjectsResource(
  auth: Auth,
): (input: z.input<typeof objectsRequestSchema>) => Promise<ObjectsResponse> {
  return auth.getResource<z.input<typeof objectsRequestSchema>, ObjectsResponse>(
    "objects",
  );
}
