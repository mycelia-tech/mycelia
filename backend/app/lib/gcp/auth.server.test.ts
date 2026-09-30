import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.15";
import { fetchGoogleWithPolicy } from "./auth.server.ts";

Deno.test("Google dispatch rechecks policy even with an already prepared credential", async () => {
  let enabled = true;
  let requests = 0;
  const dependencies = {
    loadConfig: async () => ({ externalServices: { google: { enabled } } }),
    fetch: (async (_url, init) => {
      requests++;
      assertEquals(init?.redirect, "error");
      return new Response("{}");
    }) as typeof fetch,
  };
  const preparedRequest = {
    headers: { Authorization: "Bearer prepared-test-token" },
  };
  enabled = false;
  await assertRejects(
    () =>
      fetchGoogleWithPolicy(
        "https://example.googleapis.com",
        preparedRequest,
        dependencies,
      ),
    Error,
    "GOOGLE_SERVICES_DISABLED",
  );
  assertEquals(requests, 0);
  enabled = true;
  await fetchGoogleWithPolicy(
    "https://example.googleapis.com",
    preparedRequest,
    dependencies,
  );
  assertEquals(requests, 1);
});
