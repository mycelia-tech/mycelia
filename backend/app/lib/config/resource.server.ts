import { z } from "zod";
import { ObjectId } from "bson";
import { Resource, defaultResourceManager } from "@/lib/auth/resources.ts";
import { type Auth } from "@/lib/auth/core.server.ts";
import { ServerConfig, zServerConfig } from "@myceliasdk/config.ts";
import { parse as parseYaml } from "yaml";
import { exists } from "@std/fs";
import { join } from "@std/path";

const SERVER_CONFIG_ID = new ObjectId("000000000000000000000000");


const getConfigSchema = z.object({
  action: z.literal("get"),
  path: z.string().optional().describe("Optional dot-notation path to get specific config section (e.g., 'inference.apiKey')"),
});

const updateConfigSchema = z.object({
  action: z.literal("update"),
  config: z.record(z.string(), z.any()).describe("Full config object to replace existing config"),
});

const patchConfigSchema = z.object({
  action: z.literal("patch"),
  path: z.string().optional().describe("Optional dot-notation path for partial updates"),
  updates: z.record(z.string(), z.any()).describe("Config updates to merge into existing config"),
});

const configRequestSchema = z.discriminatedUnion("action", [
  getConfigSchema,
  updateConfigSchema,
  patchConfigSchema,
]);

export type ConfigRequest = z.infer<typeof configRequestSchema>;
export type ConfigResponse = ServerConfig | Partial<ServerConfig> | unknown;

export class ConfigResource implements Resource<ConfigRequest, ConfigResponse> {
  code = "config";
  description = "Server configuration management";
  schemas = {
    request: configRequestSchema,
    response: z.any(),
  };

  extractActions(input: ConfigRequest) {
    if (input.action === "get") {
      return [{
        path: ["config", "read"],
        actions: ["read"],
      }];
    }
    return [{
      path: ["config", "write"],
      actions: ["write"],
    }];
  }

  async use(input: ConfigRequest, auth: Auth): Promise<ConfigResponse> {
    if (input.action === "get") {
      const config = await this.getResolvedConfig(auth);
      
      if (input.path) {
        return this.getNestedValue(config, input.path);
      }
      
      return config;
    }

    if (input.action === "update") {
      return await this.updateConfig(auth, input.config);
    }

    if (input.action === "patch") {
      return await this.patchConfig(auth, input.path, input.updates);
    }

    throw new Error("Invalid action");
  }

  /**
   * Get config with priority: database > config.yml > schema defaults
   */
  private async getResolvedConfig(auth: Auth): Promise<ServerConfig> {
    // Start with schema defaults
    let resolvedConfig = this.getSchemaDefaults();

    // Layer 2: config.yml (if exists)
    const fileConfig = await this.loadConfigFile();
    if (fileConfig) {
      resolvedConfig = this.deepMerge(resolvedConfig, fileConfig);
    }

    // Layer 3: Database config (highest priority)
    const dbConfig = await this.loadDatabaseConfig(auth);
    if (dbConfig) {
      resolvedConfig = this.deepMerge(resolvedConfig, dbConfig);
    }

    // Validate the merged config
    try {
      return zServerConfig.parse(resolvedConfig);
    } catch (error) {
      console.error("Config validation failed:", error);
      const message = error instanceof z.ZodError
        ? error.issues.map((e: z.core.$ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ')
        : String(error);
      throw new Error(`Configuration is invalid: ${message}`);
    }
  }

  private getSchemaDefaults(): Partial<ServerConfig> {
    const now = new Date();
    return {
      inference: null,
      features: {
        enable_speaker_identification: false,
      },
      workers: {},
      createdAt: now,
      updatedAt: now,
    };
  }

  private async loadConfigFile(): Promise<Partial<ServerConfig> | null> {
    try {
      const configPath = join(Deno.cwd(), "config.yml");
      if (await exists(configPath)) {
        const content = await Deno.readTextFile(configPath);
        return parseYaml(content) as Partial<ServerConfig>;
      }
    } catch (error) {
      console.warn("Failed to load config.yml:", error);
    }
    return null;
  }

  private async loadDatabaseConfig(auth: Auth): Promise<Partial<ServerConfig> | null> {
    try {
      const mongoResource = defaultResourceManager.getResource("mongo", auth);
      const configDoc = await mongoResource({
        action: "findOne",
        collection: "configs",
        query: { _id: SERVER_CONFIG_ID },
      });
      
      if (configDoc) {
        // Remove MongoDB-specific fields
        const { _id, ...config } = configDoc as any;
        return config;
      }
    } catch (error) {
      console.warn("Failed to load database config:", error);
    }
    return null;
  }

  private async updateConfig(auth: Auth, configUpdates: Record<string, any>): Promise<ConfigResponse> {
    try {
      // Validate the new config
      const validatedConfig = zServerConfig.parse(configUpdates);
      
      const mongoResource = defaultResourceManager.getResource("mongo", auth);
      await mongoResource({
        action: "updateOne",
        collection: "configs",
        query: { _id: SERVER_CONFIG_ID },
        update: {
          $set: {
            ...validatedConfig,
            updatedAt: new Date(),
          },
        },
        options: { upsert: true },
      });

      return {
        success: true,
        message: "Configuration updated successfully",
        config: validatedConfig,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update configuration";
      throw new Error(message);
    }
  }

  private async patchConfig(auth: Auth, path: string | undefined, updates: Record<string, any>): Promise<ConfigResponse> {
    try {
      // Get current resolved config
      const currentConfig = await this.getResolvedConfig(auth);
      
      let updatedConfig;
      if (path) {
        // Update specific path - merge updates into existing value at path
        updatedConfig = { ...currentConfig };
        const existingValue = this.getNestedValue(currentConfig, path);
        const mergedValue = this.deepMerge(existingValue ?? {}, updates);
        this.setNestedValue(updatedConfig, path, mergedValue);
      } else {
        // Merge updates at root level
        updatedConfig = this.deepMerge(currentConfig, updates);
      }

      // Add timestamp
      updatedConfig.updatedAt = new Date();

      // Validate the patched config
      const validatedConfig = zServerConfig.parse(updatedConfig);
      
      const mongoResource = defaultResourceManager.getResource("mongo", auth);
      await mongoResource({
        action: "updateOne",
        collection: "configs",
        query: { _id: SERVER_CONFIG_ID },
        update: {
          $set: validatedConfig,
        },
        options: { upsert: true },
      });

      return {
        success: true,
        message: "Configuration updated successfully",
        config: validatedConfig,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to patch configuration";
      throw new Error(message);
    }
  }

  private deepMerge(target: any, source: any): any {
    const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

    if (source === null || source === undefined) {
      return target;
    }

    if (target === null || target === undefined) {
      return source;
    }

    if (typeof source !== 'object' || typeof target !== 'object') {
      return source;
    }

    // Don't recursively merge Date objects or ObjectIds
    if (source instanceof Date || source instanceof ObjectId) {
      return source;
    }

    const result = { ...target };

    for (const key in source) {
      if (FORBIDDEN_KEYS.includes(key)) {
        continue;
      }
      if (source[key] !== undefined) {
        const sourceVal = source[key];
        const targetVal = target[key];

        // Skip recursive merge for Date, ObjectId, or arrays
        if (sourceVal instanceof Date || sourceVal instanceof ObjectId || Array.isArray(sourceVal)) {
          result[key] = sourceVal;
        } else if (typeof sourceVal === 'object' && sourceVal !== null &&
            typeof targetVal === 'object' && targetVal !== null && !Array.isArray(targetVal)) {
          result[key] = this.deepMerge(targetVal, sourceVal);
        } else {
          result[key] = sourceVal;
        }
      }
    }

    return result;
  }

  private getNestedValue(obj: any, path: string): any {
    const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
    const keys = path.split('.');

    for (const key of keys) {
      if (FORBIDDEN_KEYS.includes(key)) {
        throw new Error(`Invalid config path: '${key}' is not allowed`);
      }
    }

    return keys.reduce((current, key) => current?.[key], obj);
  }

  private setNestedValue(obj: any, path: string, value: any): void {
    const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
    const keys = path.split('.');

    for (const key of keys) {
      if (FORBIDDEN_KEYS.includes(key)) {
        throw new Error(`Invalid config path: '${key}' is not allowed`);
      }
    }

    const lastKey = keys.pop()!;
    const target = keys.reduce((current, key) => {
      if (!current[key] || typeof current[key] !== 'object') {
        current[key] = {};
      }
      return current[key];
    }, obj);
    target[lastKey] = value;
  }
}

export async function getConfigResource(auth: Auth) {
  return defaultResourceManager.getResource<ConfigRequest, ConfigResponse>(
    new ConfigResource().code,
    auth,
  );
}
