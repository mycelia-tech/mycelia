import { expect } from "@std/expect";
import { Auth } from "@/lib/auth/core.server.ts";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { getConfigResource as getConfigResourceFn } from "@/lib/config/resource.server.ts";
import { ServerConfig } from "@myceliasdk/config.ts";

async function getConfigResource(auth: Auth) {
  return getConfigResourceFn(auth);
}

Deno.test(
  "config resource is registered",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const resource = await getConfigResource(admin);
    expect(resource).toBeDefined();
  }),
);

Deno.test(
  "get config returns merged values when DB is empty (schema defaults + config.yml)",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const configResource = await getConfigResource(admin);

    const result = await configResource({
      action: "get",
    }) as ServerConfig;

    // When DB is empty, config.yml values take precedence over schema defaults
    expect(result).toBeDefined();
    expect(result.features).toBeDefined();
  }),
);

Deno.test(
  "update and get config",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const configResource = await getConfigResource(admin);

    const newConfig = {
      inference: {
        baseUrl: "https://api.bigbrother.com",
        apiKey: "sk-test",
      },
      features: {
        enable_speaker_identification: true,
      },
      workers: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await configResource({
      action: "update",
      config: newConfig,
    });

    const result = await configResource({
      action: "get",
    }) as ServerConfig;

    expect(result.features.enable_speaker_identification).toBe(true);
    expect(result.inference?.baseUrl).toBe("https://api.bigbrother.com");
  }),
);

Deno.test(
  "patch config",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const configResource = await getConfigResource(admin);

    await configResource({
      action: "patch",
      path: "features",
      updates: {
        enable_speaker_identification: true,
      },
    });

    const result = await configResource({
      action: "get",
      path: "features.enable_speaker_identification",
    });

    expect(result).toBe(true);
  }),
);

Deno.test(
  "patch config with nested path",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const configResource = await getConfigResource(admin);

    await configResource({
      action: "patch",
      path: "inference",
      updates: {
        baseUrl: "https://api.bigbrother.com",
        apiKey: "sk-patch",
      },
    });

    const result = await configResource({
      action: "get",
    }) as ServerConfig;

    expect(result.inference?.apiKey).toBe("sk-patch");
    expect(result.inference?.baseUrl).toBe("https://api.bigbrother.com");
  }),
);
