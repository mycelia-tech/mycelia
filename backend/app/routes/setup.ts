import type { Request, Response } from "express";
import { Auth, getServerAuth } from "@/lib/auth/core.server.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { generateApiKeyWithId } from "@/lib/auth/tokens.ts";
import type { Policy } from "@/lib/auth/resources.ts";
import { getObjectsResource } from "../lib/objects/resource.server.ts";
import { createHash, timingSafeEqual } from "node:crypto";

async function createPostInstallObjects(auth: Auth) {
  const objects = await getObjectsResource(auth);

  const me = await objects({
    action: "create",
    object: {
      name: "Me",
      isPerson: true,
      icon: { text: "👤" },
      messenger: {
        mycelia: {
          id: auth.principal,
        },
      },
    },
  });

  const mycelia = await objects({
    action: "create",
    object: {
      name: "Mycelia",
      icon: { text: "🍄" },
      messenger: {
        mycelia: {
          id: "system_assistant",
        },
      },
    },
  });

  await objects({
    action: "create",
    object: {
      name: "installed",
      isRelationship: true,
      relationship: {
        subject: me.insertedId.toString(),
        object: mycelia.insertedId.toString(),
        symmetrical: false,
      },
      timeRanges: [{ start: new Date() }],
    },
  });
}

export function createSetupHandler(dependencies: {
  mongo?: () => Promise<any>;
  createKey?: typeof generateApiKeyWithId;
  createObjects?: typeof createPostInstallObjects;
  bootstrapToken?: () => string | undefined;
} = {}) {
  return async function setupHandler(req: Request, res: Response) {
    try {
      res.setHeader("Cache-Control", "no-store");
      const createCredentials = req.body?.create === true;

      // Only create credentials when explicitly requested
      if (!createCredentials) {
        res.json({
          created: false,
          service: "mycelia",
          bootstrapRequired: true,
        });
        return;
      }

      const expected = (dependencies.bootstrapToken ?? (() =>
        Deno.env.get("MYCELIA_BOOTSTRAP_TOKEN")))();
      const provided = req.headers["x-mycelia-bootstrap"];
      if (
        !expected || expected.length < 32 || typeof provided !== "string" ||
        !timingSafeEqual(
          createHash("sha256").update(expected).digest(),
          createHash("sha256").update(provided).digest(),
        )
      ) {
        res.status(403).json({
          created: false,
          error: "bootstrap_token_required",
        });
        return;
      }

      // Check if any API keys already exist
      const mongo = await (dependencies.mongo ?? (async () =>
        getMongoResource(await getServerAuth())))();

      const existingKeys = await mongo({
        action: "find",
        collection: "api_keys",
        query: {},
        options: { limit: 1 },
      });

      if (existingKeys && existingKeys.length > 0) {
        // API keys already exist, refuse to create new ones via web UI
        res.status(400).json({
          created: false,
          error: "keys_exist",
          message: "API keys already exist. Generate new keys via CLI.",
        });
        return;
      }

      // A fixed _id makes enrollment atomic across concurrent requests/processes.
      // Keep the claim on failure: local CLI recovery is safer than issuing a
      // second administrator key after an ambiguous write.
      try {
        await mongo({
          action: "insertOne",
          collection: "auth_bootstrap",
          doc: { _id: "initial-admin", claimedAt: new Date() },
        });
      } catch (error) {
        const databaseError = error instanceof Error && error.cause
          ? error.cause
          : error;
        if ((databaseError as { code?: number })?.code !== 11000) {
          throw error;
        }
        res.status(409).json({
          created: false,
          error: "bootstrap_already_claimed",
        });
        return;
      }

      // No API keys exist, create the first one with root permissions
      const policies: Policy[] = [
        { resource: "**", action: "**", effect: "allow" },
      ];

      const { apiKey, clientId } =
        await (dependencies.createKey ?? generateApiKeyWithId)(
          "admin",
          "default",
          policies,
        );

      console.log("First-run setup: Created initial API key");

      const userAuth = new Auth({
        principal: "admin",
        policies: policies,
      });

      try {
        await (dependencies.createObjects ?? createPostInstallObjects)(
          userAuth,
        );
      } catch {
        // Credentials are already durable; do not strand the owner by discarding
        // the only copy of the newly generated secret when seed objects fail.
        console.error(
          "First-run setup: optional initial objects could not be created",
        );
      }

      res.json({
        created: true,
        clientId,
        clientSecret: apiKey,
      });
    } catch (error) {
      console.error("First-run setup failed; inspect local bootstrap state");
      res.status(500).json({
        error: "Failed to run setup",
      });
    }
  };
}

export const setupHandler = createSetupHandler();
