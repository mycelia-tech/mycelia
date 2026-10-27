import { z } from "zod";
import { ObjectId, ObjectIdLike } from "bson";
import ms from "ms";

function withJsonSchema<T extends z.ZodType>(
  schema: T,
  jsonSchema: Record<string, unknown>
): T {
  Object.assign(schema._zod, { toJSONSchema: () => jsonSchema });
  // Zod 4's .describe()/.meta() clone the instance (new _zod) but share the
  // same def object, so the schema must also live on the def to survive them.
  Object.assign(schema._zod.def, { myceliaJsonSchema: jsonSchema });
  return schema;
}

export const zObjectId = () => withJsonSchema(z.custom<ObjectId>((val) => {
  return ObjectId.isValid(val as ObjectIdLike | string);
}, {
  message: "Not a valid ObjectId (must be a 24-character hex string)",
}).transform((val) => new ObjectId(val)), { type: "string", description: "MongoDB ObjectId as a 24-character hex string" });



export const zDateOrString = () =>
  withJsonSchema(
    z.union([
      z.date(),
      z.string().transform((val) => new Date(val)),
    ]),
    { type: "string", format: "date-time", description: "ISO 8601 date string or Date object" }
  );

export const parseDateOrRelativeTime = (expr: string | Date): Date | undefined => {
  if (expr instanceof Date) {
    return expr;
  }

  try {
    const relativeMs = ms(expr as Parameters<typeof ms>[0]);
    if (relativeMs) {
      return new Date(Date.now() - relativeMs);
    }
    return new Date(expr);
  } catch {
    throw new Error(
      `Invalid time expression: ${expr}. Use format like "5d" or "10m" or an ISO date`,
    );
  }
}

export const zDateOrRelativeTime = (description?: string) =>
  withJsonSchema(
    z.union([z.date(), z.string()]).transform((val) => parseDateOrRelativeTime(val)),
    { 
      type: "string", 
      description: description ?? "Date as ISO 8601 string or relative time like '5d', '10m', '1h'" 
    }
  );

