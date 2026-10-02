import type { Db } from "mongodb";

type WriteInput = { action: string; collection: string; [key: string]: any };
type WriteIntent = { id: string; days: Date[]; expiresAt?: Date };
type WriteLifecycle = {
  begin: (db: Db, days: Date[]) => Promise<WriteIntent>;
  extend: (db: Db, intent: WriteIntent, days: Date[]) => Promise<void>;
  finish: (db: Db, intent: WriteIntent) => Promise<void>;
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const PREIMAGE_MAX_TIME_MS = 5_000;
export const TIMELINE_DENSITY_SOURCE_WRITE_TIMEOUT_MS = 60_000;

function dateValue(value: unknown): Date | null {
  if (
    !(value instanceof Date) && typeof value !== "string" &&
    typeof value !== "number"
  ) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function touchesStart(field: string): boolean {
  return field === "start" || field.startsWith("start.");
}

function touchesDensity(field: string, collection: string): boolean {
  return touchesStart(field) || collection === "audio_chunks" &&
      (field === "vad" || field === "vad.prob" || field === "vad.has_speech" ||
        field.startsWith("vad.prob.") || field.startsWith("vad.has_speech."));
}

function changesTimelineDensity(input: WriteInput): boolean {
  if (
    input.collection !== "audio_chunks" && input.collection !== "transcriptions"
  ) {
    return false;
  }
  const relevantUpdate = (
    update: Record<string, any>,
    upsert: boolean,
  ): boolean =>
    upsert ||
    Object.entries(update).some(([operator, fields]) =>
      operator !== "$setOnInsert" &&
      Object.entries(fields ?? {}).some(([field, value]) =>
        touchesDensity(field, input.collection) ||
        operator === "$rename" && typeof value === "string" &&
          touchesDensity(value, input.collection)
      )
    );
  switch (input.action) {
    case "insertOne":
    case "insertMany":
    case "deleteOne":
    case "deleteMany":
      return true;
    case "updateOne":
    case "updateMany":
    case "findOneAndUpdate":
      return relevantUpdate(input.update ?? {}, input.options?.upsert === true);
    case "bulkWrite":
      return (input.operations ?? []).some((operation: Record<string, any>) =>
        operation.insertOne || operation.insertMany || operation.deleteOne ||
        operation.deleteMany || operation.replaceOne ||
        [operation.updateOne, operation.updateMany].some((entry) =>
          entry && relevantUpdate(entry.update ?? {}, entry.upsert === true)
        )
      );
    default:
      return false;
  }
}

/** Collect membership dates before deletes/moves, without loading audio/text. */
export async function collectTimelineDensityWriteDays(
  db: Db,
  input: WriteInput,
): Promise<Date[]> {
  if (
    input.collection !== "audio_chunks" && input.collection !== "transcriptions"
  ) {
    return [];
  }
  const days = new Map<number, Date>();
  const queries: Record<string, any>[] = [];
  const addDate = (value: unknown): boolean => {
    const date = dateValue(value);
    if (!date) return false;
    const timestamp = Math.floor(date.getTime() / DAY_MS) * DAY_MS;
    days.set(timestamp, new Date(timestamp));
    return true;
  };
  const addQueryStart = (query: Record<string, any>): boolean => {
    let found = addDate(query.start?.$eq ?? query.start);
    for (const part of query.$and ?? []) {
      found = addQueryStart(part) || found;
    }
    return found;
  };
  const addUpdate = (
    query: Record<string, any>,
    update: Record<string, any>,
    upsert: boolean,
  ) => {
    let changesExisting = false;
    let hasNewStart = false;
    for (const [operator, fields] of Object.entries(update)) {
      if (operator === "$setOnInsert" && !upsert) continue;
      for (const [field, value] of Object.entries(fields ?? {})) {
        const renamedField = operator === "$rename" && typeof value === "string"
          ? value
          : "";
        if (touchesStart(field) || touchesStart(renamedField)) {
          if (
            field !== "start" ||
            !["$set", "$setOnInsert", "$unset"].includes(operator)
          ) {
            throw new Error(
              "Timeline density requires literal start values in $set/$setOnInsert, or $unset; computed or renamed start updates are unsupported",
            );
          }
          if (operator !== "$unset") {
            hasNewStart = addDate(value) || hasNewStart;
          }
        }
        if (
          operator !== "$setOnInsert" &&
          (touchesDensity(field, input.collection) ||
            touchesDensity(renamedField, input.collection))
        ) {
          changesExisting = true;
        }
      }
    }
    if (upsert) hasNewStart = addQueryStart(query) || hasNewStart;
    // Ingestion uses $setOnInsert with an explicit start. Existing rows only
    // receive updatedAt, so no preimage query is needed for these large batches.
    if (changesExisting || upsert && !hasNewStart) queries.push(query);
  };
  const addOperation = (operation: Record<string, any>) => {
    if (operation.insertOne) addDate(operation.insertOne.document?.start);
    if (operation.insertMany) {
      for (const document of operation.insertMany.documents ?? []) {
        addDate(document.start);
      }
    }
    for (const key of ["updateOne", "updateMany"]) {
      const update = operation[key];
      if (update) {
        addUpdate(
          update.filter ?? {},
          update.update ?? {},
          update.upsert === true,
        );
      }
    }
    if (operation.replaceOne) {
      addDate(operation.replaceOne.replacement?.start);
      queries.push(operation.replaceOne.filter ?? {});
    }
    for (const key of ["deleteOne", "deleteMany"]) {
      if (operation[key]) queries.push(operation[key].filter ?? {});
    }
  };

  switch (input.action) {
    case "insertOne":
      addDate(input.doc?.start);
      break;
    case "insertMany":
      for (const document of input.docs ?? []) addDate(document.start);
      break;
    case "updateOne":
    case "updateMany":
    case "findOneAndUpdate":
      addUpdate(
        input.query ?? {},
        input.update ?? {},
        input.options?.upsert === true,
      );
      break;
    case "deleteOne":
    case "deleteMany":
      queries.push(input.query ?? {});
      break;
    case "bulkWrite":
      for (const operation of input.operations ?? []) addOperation(operation);
      break;
  }

  if (queries.length > 0) {
    // Group in Mongo instead of hydrating source documents. One aggregation
    // covers a whole VAD bulk request, with one returned value per UTC day.
    const previous = await db.collection(input.collection).aggregate([
      { $match: queries.length === 1 ? queries[0] : { $or: queries } },
      { $match: { start: { $type: "date" } } },
      {
        $group: {
          _id: { $dateTrunc: { date: "$start", unit: "day", timezone: "UTC" } },
        },
      },
    ], { maxTimeMS: PREIMAGE_MAX_TIME_MS }).toArray();
    for (const document of previous) addDate(document._id);
  }
  return [...days.values()].sort((left, right) =>
    left.getTime() - right.getTime()
  );
}

export async function withTimelineDensityWrite<T>(
  db: Db,
  input: WriteInput,
  execute: () => Promise<T>,
  lifecycle?: WriteLifecycle,
): Promise<T> {
  if (!changesTimelineDensity(input)) return await execute();
  if (!lifecycle) {
    const maintenance = await import("./density-maintenance.ts");
    lifecycle = {
      begin: maintenance.beginTimelineDensityWrite,
      extend: maintenance.extendTimelineDensityWrite,
      finish: maintenance.finishTimelineDensityWrite,
    };
  }
  // Block maintenance acknowledgements before the preimage read. A concurrent
  // insert can then leave its own day pending even if this broad mutation's
  // preimage query ran before the inserted document existed.
  const intent = await lifecycle.begin(db, []);
  let sourceOutcome: "not-started" | "unknown" | "succeeded" = "not-started";
  try {
    intent.days = await collectTimelineDensityWriteDays(db, input);
    await lifecycle.extend(db, intent, intent.days);
    if (
      intent.expiresAt &&
      Date.now() + 2 * TIMELINE_DENSITY_SOURCE_WRITE_TIMEOUT_MS >=
        intent.expiresAt.getTime()
    ) {
      throw new Error(
        "Timeline density write intent expires before the source write safety window",
      );
    }
    sourceOutcome = "unknown";
    const result = await execute();
    sourceOutcome = "succeeded";
    return result;
  } finally {
    // A rejected source operation may still be mutating on MongoDB after a
    // lost acknowledgement. Leave its barrier until expiry recovery. Before
    // execution and after confirmed success it is safe to settle immediately.
    if (sourceOutcome !== "unknown") {
      try {
        await lifecycle.finish(db, intent);
      } catch (error) {
        console.error(
          "[TimelineDensity] Write settlement deferred to recovery:",
          error,
        );
      }
    }
  }
}
