import type { ResourceAction } from "@/lib/auth/resources.ts";
import { permissionDenied } from "@/lib/auth/utils.ts";

// Unknown stages fail closed: a new stage may access a second namespace or
// perform writes. Expressions inside these stages cannot open a namespace.
const READ_STAGES = new Set([
  "$addFields",
  "$bucket",
  "$bucketAuto",
  "$count",
  "$densify",
  "$documents",
  "$fill",
  "$geoNear",
  "$group",
  "$limit",
  "$match",
  "$project",
  "$redact",
  "$replaceRoot",
  "$replaceWith",
  "$sample",
  "$search",
  "$searchMeta",
  "$set",
  "$setWindowFields",
  "$skip",
  "$sort",
  "$sortByCount",
  "$unset",
  "$unwind",
  "$vectorSearch",
]);

function namespace(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    permissionDenied(
      "Aggregation requires an explicit collection in the current database",
    );
  }
  return value;
}

function outputNamespace(value: unknown): string {
  if (typeof value === "string") return namespace(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const target = value as Record<string, unknown>;
    // Database-scoped policies cannot authorize another database.
    if (target.db !== undefined) {
      permissionDenied("Cross-database aggregation is not supported");
    }
    return namespace(target.coll);
  }
  return namespace(value);
}

export function aggregateResourceActions(
  collection: string,
  pipeline: readonly Record<string, unknown>[],
  readOnly = false,
): ResourceAction[] {
  const actions = new Map<string, Set<string>>();
  const add = (name: string, requested: string[]) => {
    const existing = actions.get(name) ?? new Set<string>();
    requested.forEach((action) => existing.add(action));
    actions.set(name, existing);
  };
  add(collection, ["read"]);

  const visit = (stages: unknown, depth: number) => {
    if (!Array.isArray(stages) || depth > 20) {
      permissionDenied("Invalid or excessively nested aggregation pipeline");
    }
    for (const stage of stages) {
      if (
        !stage || typeof stage !== "object" || Array.isArray(stage) ||
        Object.keys(stage).length !== 1
      ) {
        permissionDenied("Invalid aggregation stage");
      }
      const [operator, value] = Object.entries(stage)[0];
      if (READ_STAGES.has(operator)) continue;
      if (operator === "$lookup" || operator === "$graphLookup") {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          permissionDenied("Invalid lookup");
        }
        const lookup = value as Record<string, unknown>;
        if (lookup.from !== undefined) add(namespace(lookup.from), ["read"]);
        else if (
          operator === "$graphLookup" || !Array.isArray(lookup.pipeline) ||
          !(lookup.pipeline[0]?.$documents)
        ) {
          permissionDenied("Lookup requires an explicit collection");
        }
        if (lookup.pipeline !== undefined) visit(lookup.pipeline, depth + 1);
      } else if (operator === "$unionWith") {
        if (typeof value === "string") add(namespace(value), ["read"]);
        else if (value && typeof value === "object" && !Array.isArray(value)) {
          const union = value as Record<string, unknown>;
          add(namespace(union.coll), ["read"]);
          if (union.pipeline !== undefined) visit(union.pipeline, depth + 1);
        } else permissionDenied("Invalid union namespace");
      } else if (operator === "$facet") {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          permissionDenied("Invalid facet");
        }
        Object.values(value).forEach((nested) => visit(nested, depth + 1));
      } else if (operator === "$out" || operator === "$merge") {
        if (readOnly) permissionDenied("Chat aggregation is read-only");
        const target =
          operator === "$merge" && value && typeof value === "object"
            ? (value as Record<string, unknown>).into
            : value;
        add(outputNamespace(target), ["write", "update", "delete"]);
      } else {
        permissionDenied(
          `Aggregation stage ${operator} is not supported by the authorization policy`,
        );
      }
    }
  };
  visit(pipeline, 0);
  return [...actions].map(([name, requested]) => ({
    path: ["db", name],
    actions: [...requested],
  }));
}
