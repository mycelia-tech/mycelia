import { assertEquals } from "jsr:@std/assert@^1.0.15";
import { schema } from "./ingestion.ts";

Deno.test("ingestion explicit retry requires selected source IDs", () => {
  assertEquals(
    schema.safeParse({ type: "ingestion", retryErrors: true }).success,
    false,
  );
  assertEquals(
    schema.safeParse({ type: "ingestion", sourceIds: ["invalid"] }).success,
    false,
  );
  const selected = {
    type: "ingestion",
    sourceIds: ["507f1f77bcf86cd799439011"],
    retryErrors: true,
    limit: 1,
  };
  assertEquals(schema.safeParse(selected).success, true);
  assertEquals(
    schema.safeParse({ ...selected, sourceFolder: "/fixture" }).success,
    false,
  );
  assertEquals(schema.parse({ type: "ingestion" }).retryErrors, false);
});
