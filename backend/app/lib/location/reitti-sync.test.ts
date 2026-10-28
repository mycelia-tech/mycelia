import { expect } from "@std/expect";
import { dayOffset, planReittiSync, readReittiExport } from "./reitti-sync.ts";

Deno.test("first run prioritizes recent UTC days then resumes history backwards", () => {
  const plan = planReittiSync(
    "2025-07-01",
    {},
    new Date("2026-10-28T22:00:00Z"),
  );
  expect(plan.days).toEqual([
    "2026-10-26",
    "2026-10-27",
    "2026-10-28",
    "2026-10-25",
    "2026-10-24",
    "2026-10-23",
    "2026-10-22",
  ]);
  const next = planReittiSync(
    "2025-07-01",
    plan,
    new Date("2026-10-28T22:05:00Z"),
  );
  expect(next.days[0]).toBe("2026-10-21");
  expect(new Set([...plan.days, ...next.days]).size).toBe(14);
});
Deno.test("long outage catches all missed days across bounded resumable batches", () => {
  let state = {
    recentAt: "2026-10-01T00:00:00Z",
    nextHistoryDay: "2025-06-30",
  };
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const plan = planReittiSync(
      "2025-07-01",
      state,
      new Date("2026-10-28T22:00:00Z"),
    );
    expect(plan.days.length).toBeLessThanOrEqual(7);
    plan.days.forEach((day) => seen.add(day));
    state = { ...state, ...plan, recentAt: plan.recentAt! };
    if (!plan.hasMore) break;
  }
  for (let day = "2026-10-01"; day <= "2026-10-28"; day = dayOffset(day, 1)) {
    expect(seen.has(day)).toBe(true);
  }
  expect(state.recentAt).toBe("2026-10-28T22:00:00.000Z");
});
Deno.test("hourly overlap plus historical audit, no work before next hour", () => {
  const now = new Date("2026-10-28T22:00:00Z");
  const state = {
    recentAt: "2026-10-28T20:59:00Z",
    nextHistoryDay: "2025-06-30",
    auditDay: "2025-08-01",
  };
  const plan = planReittiSync("2025-07-01", state, now);
  expect(plan.days).toEqual([
    "2026-10-26",
    "2026-10-27",
    "2026-10-28",
    "2025-08-01",
  ]);
  expect(plan.hasMore).toBe(false);
  expect(planReittiSync("2025-07-01", plan, now).days).toEqual([]);
  expect(() => planReittiSync("2026-02-30", {}, now)).toThrow();
});
Deno.test("export uses inclusive UTC day, header token, verified HTTPS and no redirects", async () => {
  const fake = ((url: URL, options: RequestInit) => {
    expect(url.searchParams.get("start")).toBe("2026-10-28");
    expect(url.searchParams.get("end")).toBe("2026-10-28");
    expect(url.searchParams.get("device")).toBe("1");
    expect(url.href.includes("secret")).toBe(false);
    expect(options.redirect).toBe("error");
    expect(options.headers).toEqual({ "X-API-TOKEN": "secret" });
    return Promise.resolve(new Response('<gpx version="1.1"></gpx>'));
  }) as typeof fetch;
  expect(
    (await readReittiExport(
      "https://example.com",
      "secret",
      "1",
      "2026-10-28",
      fake,
    )).length,
  ).toBeGreaterThan(0);
  await expect(
    readReittiExport("http://example.com", "secret", "1", "2026-10-28", fake),
  ).rejects.toThrow("HTTPS");
});
Deno.test("login pages, truncated exports, and HTTP errors cannot become empty-day checkpoints", async () => {
  for (const body of ["<html>Login</html>", "<gpx><trk>"]) {
    await expect(
      readReittiExport(
        "https://example.com",
        "secret",
        "1",
        "2026-10-28",
        (() => Promise.resolve(new Response(body))) as typeof fetch,
      ),
    ).rejects.toThrow("incomplete GPX");
  }
  await expect(
    readReittiExport(
      "https://example.com",
      "secret",
      "1",
      "2026-10-28",
      (() =>
        Promise.resolve(
          new Response("private body", { status: 403 }),
        )) as typeof fetch,
    ),
  ).rejects.toThrow("HTTP 403");
});
