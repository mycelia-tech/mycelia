/** Reitti exports inclusive UTC dates. Keep planning independent of transport. */
export const HOUR_MS = 3_600_000;
export function dayOffset(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
export function validDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day)) &&
    new Date(day).toISOString().slice(0, 10) === day;
}
export interface ReittiState {
  nextHistoryDay?: string;
  recentAt?: string;
  auditDay?: string;
  recentCursor?: string | null;
}
export function planReittiSync(
  start: string,
  state: ReittiState,
  now: Date,
  batchSize = 7,
) {
  if (!validDay(start)) throw new Error("Invalid REITTI_START_DATE");
  const today = now.toISOString().slice(0, 10);
  if (start > today) throw new Error("REITTI_START_DATE is in the future");
  const recentDue = !state.recentAt ||
    now.getTime() - Date.parse(state.recentAt) >= HOUR_MS;
  const days: string[] = [];
  let recentCursor: string | null = null;
  if (recentDue) {
    let day = state.recentCursor ??
      dayOffset(state.recentAt?.slice(0, 10) ?? today, -2);
    if (day < start) day = start;
    while (day <= today && days.length < batchSize) {
      days.push(day);
      day = dayOffset(day, 1);
    }
    if (day <= today) recentCursor = day;
  }
  let cursor = state.nextHistoryDay ?? dayOffset(today, -3);
  if (recentCursor) {
    return {
      days,
      nextHistoryDay: cursor,
      recentAt: state.recentAt,
      recentCursor,
      hasMore: true,
      auditDay: state.auditDay,
    };
  }
  while (cursor >= start && days.length < batchSize) {
    if (!days.includes(cursor)) days.push(cursor);
    cursor = dayOffset(cursor, -1);
  }
  let auditDay = state.auditDay ?? start;
  if (cursor < start && recentDue && days.length < batchSize) {
    if (auditDay > today || auditDay < start) auditDay = start;
    if (!days.includes(auditDay)) days.push(auditDay);
    auditDay = dayOffset(auditDay, 1);
  }
  return {
    days,
    recentCursor,
    nextHistoryDay: cursor,
    recentAt: recentDue ? now.toISOString() : state.recentAt,
    auditDay,
    hasMore: cursor >= start,
  };
}

export async function readReittiExport(
  baseUrl: string,
  token: string,
  device: string,
  day: string,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "https:" || base.username || base.password ||
    base.search || base.hash
  ) {
    throw new Error(
      "REITTI_URL must be HTTPS without credentials, query or fragment",
    );
  }
  if (!validDay(day) || !/^\d+$/.test(device)) {
    throw new Error("Invalid Reitti export range/device");
  }
  const url = new URL(
    `${base.pathname.replace(/\/$/, "")}/api/v1/gpx/export`,
    base.origin,
  );
  url.search = new URLSearchParams({ start: day, end: day, device }).toString();
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { "X-API-TOKEN": token },
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error(
      "Reitti export connection failed (network, TLS, redirect or timeout)",
    );
  }
  if (!response.ok) throw new Error(`Reitti export HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty Reitti response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 50 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Reitti daily export exceeds 50 MiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const xml = new TextDecoder().decode(bytes);
  if (!/<gpx\b/.test(xml) || !/<\/gpx>\s*$/.test(xml)) {
    throw new Error("Reitti returned incomplete GPX or a login page");
  }
  return bytes;
}
