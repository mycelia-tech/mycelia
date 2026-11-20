import { expect } from "@std/expect";
import {
  cachedLocationPointCount,
  invalidateLocationPointCount,
} from "./point-count-cache.ts";

Deno.test("point counts share pending reads and discard obsolete results", async () => {
  const database = "point-count-test";
  const original = Promise.withResolvers<number>();
  const first = cachedLocationPointCount(database, () => original.promise);
  expect(cachedLocationPointCount(database, () => Promise.resolve(99))).toBe(
    first,
  );

  invalidateLocationPointCount(database);
  expect(await cachedLocationPointCount(database, () => Promise.resolve(2)))
    .toBe(2);
  original.resolve(1);
  expect(await first).toBe(1);
  expect(await cachedLocationPointCount(database, () => Promise.resolve(99)))
    .toBe(2);
  invalidateLocationPointCount(database);
});

Deno.test("a failed point count can be retried", async () => {
  const database = "point-count-retry";
  await expect(
    cachedLocationPointCount(
      database,
      () => Promise.reject(new Error("failed")),
    ),
  ).rejects.toThrow("failed");
  expect(await cachedLocationPointCount(database, () => Promise.resolve(3)))
    .toBe(3);
  invalidateLocationPointCount(database);
});
