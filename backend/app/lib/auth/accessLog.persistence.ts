export const ACCESS_LOG_STREAM = "access_logs";
export const ACCESS_LOG_GROUP = "access_logs_group";
export const ACCESS_LOG_CONSUMER = "worker-1";
export const ACCESS_LOG_BATCH_SIZE = 100;

/** Inclusive cutover: retain existing payloads, including pending events. */
export function accessLogRetentionId(value: string | undefined): string {
  if (value === undefined || value === "") return "0-0";
  if (!/^(0|[1-9][0-9]{0,19})-(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error("ACCESS_LOG_RETAIN_THROUGH_ID must be a Redis stream ID");
  }
  return value;
}

type StreamValue = string | Uint8Array;
export type AccessLogEntry = [StreamValue, StreamValue[] | null];
export type StoredAccessLog = Record<string, unknown> & { _id: string };

export interface AccessLogPersistence {
  // Implementations must upsert by _id; a lost acknowledgement can redeliver.
  persist: (
    collection: "access_logs" | "access_logs_failed",
    documents: StoredAccessLog[],
  ) => Promise<void>;
  acknowledge: (ids: string[]) => Promise<void>;
}

const decode = (value: StreamValue): string =>
  typeof value === "string" ? value : new TextDecoder().decode(value);

/** Persist the complete batch before releasing any Redis entries. */
export async function persistAccessLogBatch(
  messages: AccessLogEntry[],
  storage: AccessLogPersistence,
): Promise<void> {
  const documents: StoredAccessLog[] = [];
  const failedDocuments: StoredAccessLog[] = [];
  const ids: string[] = [];

  for (const [rawId, fields] of messages) {
    const messageId = decode(rawId);
    ids.push(messageId);
    const rawData: Record<string, string> = {};
    if (fields) {
      for (let index = 0; index + 1 < fields.length; index += 2) {
        rawData[decode(fields[index])] = decode(fields[index + 1]);
      }
    }
    const _id = `redis:${ACCESS_LOG_STREAM}:${messageId}`;
    try {
      if (!fields || fields.length % 2 !== 0) {
        throw new Error("Missing stream payload");
      }
      const actions: unknown = JSON.parse(rawData.actions);
      const timestamp = new Date(rawData.timestamp);
      if (
        !rawData.principal || !rawData.resource ||
        !Number.isFinite(timestamp.getTime()) ||
        !Array.isArray(actions) || !actions.every((action) =>
          action && (typeof action.path === "string" ||
            (Array.isArray(action.path) &&
              action.path.every((part: unknown) =>
                typeof part === "string"
              ))) &&
          Array.isArray(action.actions) &&
          action.actions.every((part: unknown) =>
            typeof part === "string"
          )
        )
      ) throw new Error("Invalid access log fields");
      documents.push({
        _id,
        messageId,
        principal: rawData.principal,
        resource: rawData.resource,
        actions,
        timestamp,
      });
    } catch {
      failedDocuments.push({
        _id,
        messageId,
        principal: rawData.principal || null,
        resource: rawData.resource || null,
        actions: rawData.actions || null,
        timestamp: new Date(),
        error: fields === null
          ? "Stream payload unavailable"
          : "Invalid access log fields",
        failedAt: new Date(),
        rawMessage: rawData,
        rawFields: fields?.map(decode) ?? null,
      });
    }
  }

  if (documents.length) await storage.persist("access_logs", documents);
  if (failedDocuments.length) {
    await storage.persist("access_logs_failed", failedDocuments);
  }
  if (ids.length) await storage.acknowledge(ids);
}

// XACK does not remove stream payloads. Delete only the exact IDs whose Mongo
// writes completed, and only when no other consumer group needs the stream.
// Keep this atomic so a concurrently created group cannot lose its entries.
// No MAXLEN/MINID trim: historical acknowledged entries need a separate audit.
export const ACKNOWLEDGE_PERSISTED_ACCESS_LOGS = `
local groups = redis.call('XINFO', 'GROUPS', KEYS[1])
local acknowledged = redis.call('XACK', KEYS[1], ARGV[1], unpack(ARGV, 3))
local deleted = 0
local function greater(a, b)
  return #a > #b or (#a == #b and a > b)
end
local cutoffMs, cutoffSequence = string.match(ARGV[2], '^(%d+)%-(%d+)$')
local eligible = {}
for i = 3, #ARGV do
  local ms, sequence = string.match(ARGV[i], '^(%d+)%-(%d+)$')
  if cutoffMs and ms and (greater(ms, cutoffMs) or
      (ms == cutoffMs and greater(sequence, cutoffSequence))) then
    table.insert(eligible, ARGV[i])
  end
end
if #groups == 1 then
  for i = 1, #groups[1], 2 do
    if groups[1][i] == 'name' and groups[1][i + 1] == ARGV[1] then
      if #eligible > 0 then
        deleted = redis.call('XDEL', KEYS[1], unpack(eligible))
      end
      break
    end
  end
end
return {acknowledged, deleted}
`;

export type StreamCommand = (...args: (string | number)[]) => Promise<unknown>;

export async function readAccessLogBatch(
  call: StreamCommand,
): Promise<AccessLogEntry[]> {
  const read = async (pending: boolean): Promise<AccessLogEntry[]> => {
    const reply = await call(
      "XREADGROUP",
      "GROUP",
      ACCESS_LOG_GROUP,
      ACCESS_LOG_CONSUMER,
      "COUNT",
      ACCESS_LOG_BATCH_SIZE,
      ...(pending ? [] : ["BLOCK", 5000]),
      "STREAMS",
      ACCESS_LOG_STREAM,
      pending ? "0" : ">",
    );
    if (!Array.isArray(reply)) return [];
    const stream = reply.find((entry) =>
      Array.isArray(entry) && decode(entry[0]) === ACCESS_LOG_STREAM
    );
    return stream && Array.isArray(stream[1]) ? stream[1] : [];
  };
  const pending = await read(true);
  return pending.length ? pending : await read(false);
}
