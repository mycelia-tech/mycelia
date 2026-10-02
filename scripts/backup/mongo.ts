import { isAbsolute } from "node:path";
import { collectBoundedStream, DenoRunner } from "./runner.ts";
import { failureError } from "./redact.ts";
import type { Runner } from "./types.ts";
export type MongoSourcePaths = {
  filteredCount: number;
  records: Array<{ _id: unknown; path: string }>;
};
export type MongoSourceOptions = {
  composeRoot: string;
  databaseName: string;
  authorization: "enabled" | "disabled";
};
const queryScript = `
try {
  const collection = db.getCollection("source_files");
  const filter = {path: {$exists: true}};
  print(JSON.stringify({type: "count", count: collection.countDocuments(filter)}));
  collection.find(filter, {_id: 1, path: 1}).forEach(record => {
    print(EJSON.stringify(record, {relaxed: false}));
  });
} catch (_) { quit(1); }
`;
const authScript = `
try {
  const user = process.env.MONGO_INITDB_ROOT_USERNAME;
  const password = process.env.MONGO_INITDB_ROOT_PASSWORD;
  if (!user || !password) quit(1);
  const result = db.getSiblingDB("admin").auth(user, password);
  if (!(result === 1 || result === true || (result && result.ok === 1))) quit(1);
} catch (_) { quit(1); }
`;

function invalid(): never {
  throw failureError("SOURCE_COVERAGE_INCOMPLETE");
}

function stableId(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableId).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => JSON.stringify(key) + ":" + stableId(entry)).join(
        ",",
      ) +
      "}";
  }
  return JSON.stringify(value);
}

/** Sensitive return value: neither IDs nor source paths belong in status/logs. */
export async function readMongoSourcePaths(
  options: MongoSourceOptions,
  runner: Runner = new DenoRunner(),
): Promise<MongoSourcePaths> {
  try {
    if (
      !isAbsolute(options.composeRoot) ||
      !/^[a-zA-Z0-9_-]+$/.test(options.databaseName) ||
      !["enabled", "disabled"].includes(options.authorization)
    ) invalid();
    const child = runner.spawn([
      "docker",
      "compose",
      "--project-directory",
      options.composeRoot,
      "exec",
      "-T",
      "mongo",
      "mongosh",
      "--quiet",
      "--norc",
      options.databaseName,
      "--file",
      "/dev/stdin",
    ], { timeoutMs: 120_000 });
    try {
      if (!child.stdin || !child.stdout || !child.stderr) invalid();
      const write = async () => {
        const writer = child.stdin!.getWriter();
        try {
          await writer.write(new TextEncoder().encode(
            (options.authorization === "enabled" ? authScript : "") +
              queryScript,
          ));
          await writer.close();
        } finally {
          writer.releaseLock();
        }
      };
      const [stdout, , status] = await Promise.all([
        collectBoundedStream(child.stdout, 64 * 1024 * 1024),
        collectBoundedStream(child.stderr, 1024 * 1024),
        child.status,
        write(),
      ]);
      if (status.code !== 0 || status.timedOut) invalid();
      const lines = new TextDecoder("utf-8", { fatal: true }).decode(stdout)
        .trim().split("\n");
      const count = JSON.parse(lines.shift()!);
      if (
        count?.type !== "count" || !Number.isSafeInteger(count.count) ||
        count.count < 0
      ) invalid();
      const records: MongoSourcePaths["records"] = [];
      const seen = new Map<string, string>();
      for (const line of lines) {
        const record = JSON.parse(line);
        if (
          !record || !Object.hasOwn(record, "_id") || record._id === null ||
          typeof record.path !== "string" || !record.path.trim()
        ) invalid();
        const id = stableId(record._id);
        if (seen.has(id) && seen.get(id) !== record.path) invalid();
        seen.set(id, record.path);
        records.push({ _id: record._id, path: record.path });
      }
      if (records.length !== count.count) invalid();
      return { filteredCount: count.count, records };
    } catch {
      child.kill();
      await child.status.catch(() => {});
      invalid();
    }
  } catch {
    invalid();
  }
}
