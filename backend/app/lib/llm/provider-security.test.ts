import { expect } from "@std/expect";
import { LLMResource } from "./resource.server.ts";
import { Auth } from "@/lib/auth/core.server.ts";
import { ResourceManager } from "@/lib/auth/resources.ts";

function resource() {
  return new LLMResource(
    async () => ({
      llmProfiles: {
        includeEnvironment: false,
        profiles: [{
          id: "saved",
          name: "Saved",
          baseUrl: "http://local-provider:8000/v1",
          apiKey: "fake-test-key",
          aliases: { small: "test", medium: "test", large: "test" },
        }],
      },
    } as never),
  );
}

Deno.test({
  name: "provider checks never inherit credentials across origins",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const previous = globalThis.fetch;
    const calls: { url: string; authorization: string | null }[] = [];
    globalThis.fetch = (url, init) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return Promise.resolve(
        new Response('{"data":[{"id":"test"}]}', {
          headers: { "Content-Type": "application/json" },
        }),
      );
    };
    try {
      for (const action of ["models", "probe"] as const) {
        await expect(
          resource().use({
            action,
            profileId: "saved",
            baseUrl: "https://other.example/v1",
          }, {} as Auth),
        ).rejects.toThrow("another origin");
      }
      expect(calls.length).toBe(0);
      await resource().use(
        { action: "models", profileId: "saved" },
        {} as Auth,
      );
      expect(calls[0]).toEqual({
        url: "http://local-provider:8000/v1/models",
        authorization: "Bearer fake-test-key",
      });
      await resource().use({
        action: "models",
        profileId: "saved",
        baseUrl: "https://other.example/v1",
        apiKey: "explicit-test-key",
      }, {} as Auth);
      expect(calls[1]).toEqual({
        url: "https://other.example/v1/models",
        authorization: "Bearer explicit-test-key",
      });
    } finally {
      globalThis.fetch = previous;
    }
  },
});

Deno.test("catalogue reader cannot probe arbitrary endpoints", async () => {
  const auth = new Auth({
    principal: "reader",
    policies: [{ resource: "llm/models", action: "list", effect: "allow" }],
  });
  const manager = new ResourceManager();
  const llm = resource();
  await manager.ensureAllowed(
    auth,
    ...llm.extractActions({ action: "models", profileId: "saved" }),
  );
  for (
    const input of [{ action: "probe", profileId: "saved" }, {
      action: "models",
      baseUrl: "http://localhost:1234/v1",
    }] as const
  ) {
    await expect(manager.ensureAllowed(auth, ...llm.extractActions(input)))
      .rejects.toBeInstanceOf(Response);
  }
});
