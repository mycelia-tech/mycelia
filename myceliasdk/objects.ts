import { z } from "zod";
import { ObjectId } from "bson";
import { zIcon } from "./icon.ts";

// Base schema without .loose() for clean type inference
const zObjectBase = z.object({
  _id: z.instanceof(ObjectId),
  name: z.string().optional(),
  details: z.string().optional(),
  icon: zIcon,
  color: z.string().optional(),
  aliases: z.array(z.string()).optional(),

  // Type flags
  isEvent: z.boolean().optional(),
  isPerson: z.boolean().optional(),
  isRelationship: z.boolean().optional(),
  isPromise: z.boolean().optional(),
  isConversation: z.boolean().optional(),
  isTag: z.boolean().optional(),
  isPlace: z.boolean().optional(),
  isOrganization: z.boolean().optional(),
  isProduct: z.boolean().optional(),
  isProject: z.boolean().optional(),
  isAnimal: z.boolean().optional(),
  isConcept: z.boolean().optional(),
  isMedia: z.boolean().optional(),

  // User flags
  starred: z.boolean().optional(),

  agreed_upon_something: z.boolean().optional(),

  relationship: z.object({
    object: z.instanceof(ObjectId),
    subject: z.instanceof(ObjectId),
    symmetrical: z.boolean(),
  }).optional(),

  location: z.object({
    latitude: z.number(),
    longitude: z.number(),
  }).optional(),

  timeRanges: z.array(z.object({
    start: z.date(),
    end: z.date().optional(),
    name: z.string().optional(),
  })).optional(),

  summaries: z.array(z.object({
    text: z.string(),
    model: z.string(),
    modelName: z.string(),
    requestedModel: z.string().optional(),
    resolvedModel: z.string().optional(),
    fallbackModel: z.string().optional(),
    fallbackUsed: z.boolean().optional(),
    providerBaseUrl: z.string().optional(),
    providerProfileId: z.string().optional(),
    providerProfileName: z.string().optional(),
    provenance: z.object({
      task: z.string(),
      requestedModel: z.string(),
      resolvedModel: z.string(),
      responseModel: z.string().optional(),
      fallbackModel: z.string().optional(),
      fallbackUsed: z.boolean(),
      providerBaseUrl: z.string().optional(),
      providerProfileId: z.string().optional(),
      providerProfileName: z.string().optional(),
    }).optional(),
    titleProvenance: z.object({
      task: z.string(),
      requestedModel: z.string(),
      resolvedModel: z.string(),
      responseModel: z.string().optional(),
      fallbackModel: z.string().optional(),
      fallbackUsed: z.boolean(),
      providerBaseUrl: z.string().optional(),
      providerProfileId: z.string().optional(),
      providerProfileName: z.string().optional(),
    }).optional(),
    date: z.date(),
    prompt: z.string().optional(),
    promptName: z.string().optional(),
    usage: z.object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      totalTokens: z.number(),
      cost: z.number().optional(),
    }).optional(),
    jobId: z.string().optional(),
    sourceRefs: z.object({
      schemaVersion: z.literal("v1"),
      selection: z.literal("time_range_overlap"),
      conversationId: z.string().optional(),
      conversationChunkIds: z.array(z.string()),
      transcriptionIds: z.array(z.string()),
      coverageStart: z.string(),
      coverageEnd: z.string(),
      extractorJobId: z.string().optional(),
    }).optional(),
    starred: z.boolean().optional(),
  })).optional(),

  metadata: z.object({
    extractedWith: z.object({
      model: z.string(),
      requestedModel: z.string().optional(),
      resolvedModel: z.string().optional(),
      responseModel: z.string().optional(),
      fallbackModel: z.string().optional(),
      fallbackUsed: z.boolean().optional(),
      providerBaseUrl: z.string().optional(),
      providerProfileId: z.string().optional(),
      providerProfileName: z.string().optional(),
      extractorVersion: z.string().optional(),
      chunkId: z.string().optional(),
      jobId: z.string().optional(),
      timestamp: z.date(),
      result: z.object({
        schemaVersion: z.string(),
        status: z.enum([
          "metadata_extracted",
          "completed",
          "completed_with_relationship_errors",
        ]),
        emojiPresent: z.boolean(),
        entityCount: z.number(),
        relationshipsAttempted: z.number(),
        relationshipsCreated: z.number(),
        relationshipErrors: z.number(),
      }).optional(),
    }).loose().optional(),
  }).loose().optional(),

  createdAt: z.date(),
  updatedAt: z.date(),
  version: z.number().optional(),
});

// Full schema with .loose() for runtime validation (allows extra fields)
export const zObject = zObjectBase.loose().refine(
  (data) => {
    if (data.isPromise) {
      return data.isRelationship === true &&
        data.relationship !== undefined;
    }
    return true;
  },
  {
    message:
      "If isPromise is true, the object must be a relationship and have at least one time interval",
    path: ["isPromise"],
  },
);

export type Object = z.infer<typeof zObject>;

type ObjectBase = z.infer<typeof zObjectBase>;

export type ObjectFormData =
  & Partial<Omit<ObjectBase, "_id" | "relationship" | "icon">>
  & {
    _id?: ObjectId;
    icon?: { text: string } | { base64: string };
    relationship?: {
      object?: ObjectId;
      subject?: ObjectId;
      symmetrical: boolean;
    };
  };

export function validateObjectForSave(
  obj: ObjectFormData,
): { valid: boolean; error?: string } {
  if (!obj.name?.trim()) {
    return { valid: false, error: "Name is required" };
  }

  if (obj.isRelationship && obj.relationship) {
    if (!obj.relationship.object || !obj.relationship.subject) {
      return {
        valid: false,
        error: "Relationship must have both subject and object configured",
      };
    }
  }

  if (obj.isPromise) {
    if (!obj.isRelationship) {
      return { valid: false, error: "Promise objects must be relationships" };
    }
    if (!obj.relationship?.object || !obj.relationship?.subject) {
      return {
        valid: false,
        error: "Promise objects must have a relationship configured",
      };
    }
    if (!obj.timeRanges || obj.timeRanges.length === 0) {
      return {
        valid: false,
        error: "Promise objects must have at least one time interval",
      };
    }
  }

  return { valid: true };
}
