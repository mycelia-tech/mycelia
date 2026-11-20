const POINT_COUNT_TTL_MS = 60_000;
type Entry = { value: Promise<number>; expiresAt: number };

const counts = new Map<string, Entry>();

export function invalidateLocationPointCount(database: string): void {
  counts.delete(database);
}

export function cachedLocationPointCount(
  database: string,
  count: () => Promise<number>,
): Promise<number> {
  const current = counts.get(database);
  if (current && current.expiresAt > Date.now()) return current.value;

  const entry: Entry = {
    value: count(),
    expiresAt: Infinity,
  };
  counts.set(database, entry);
  void entry.value.then(
    () => {
      entry.expiresAt = Date.now() + POINT_COUNT_TTL_MS;
    },
    () => {
      if (counts.get(database) === entry) counts.delete(database);
    },
  );
  return entry.value;
}
