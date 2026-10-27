import { Resource, ResourceManager } from "@/lib/auth/resources.ts";
import { Auth } from "@/lib/auth/core.server.ts";
import { z } from "zod";
import { jsonSchema, Tool, tool } from "ai";
import { EJSON } from "bson";

const MAX_RESULT_LENGTH = 25000;

function serializeResult(
  result: unknown,
): { type: "json" | "text"; value: unknown } {
  const serialized = EJSON.stringify(result);
  if (serialized.length <= MAX_RESULT_LENGTH) {
    return { type: "json", value: JSON.parse(serialized) };
  }
  const trimmed = serialized.slice(0, MAX_RESULT_LENGTH);
  return {
    type: "text",
    value: `${trimmed}... [trimmed, total ${serialized.length} characters]`,
  };
}

export interface ToolAdapterOptions {
  /** Tool names that require user approval before execution */
  toolsRequiringApproval?: string[];
  /** When provided, only tools for which this returns true are exposed */
  toolFilter?: (toolName: string) => boolean;
  /** Execute through policy extraction, matching, modifiers, and auditing. */
  resourceManager: ResourceManager;
  /** Additional restrictions imposed by the tool's execution context. */
  validateInput?: (toolName: string, input: unknown) => void;
}

async function executeResource<Input, Output>(
  resource: Resource<Input, Output>,
  input: Input,
  auth: Auth,
  resourceManager: ResourceManager,
): Promise<Output | Response> {
  const run = resourceManager.getResource<Input, Output>(resource.code, auth);
  return await run(input);
}

/**
 * Custom JSON schema attached by withJsonSchema (myceliasdk/zod-json-schema.ts).
 * Read from the instance first, then from the shared def — .describe()/.meta()
 * clone the instance (losing _zod.toJSONSchema) but keep the same def.
 * The instance description (added via .describe()) wins over the stashed one.
 */
function customJsonSchemaOf(
  zodSchema: any,
): Record<string, unknown> | undefined {
  const custom = zodSchema?._zod?.toJSONSchema?.() ??
    zodSchema?._zod?.def?.myceliaJsonSchema;
  if (!custom) return undefined;
  const description = zodSchema?.description;
  return { ...custom, ...(description ? { description } : {}) };
}

export function zodSchemaToJsonSchema(
  schema: z.ZodType,
): Record<string, unknown> {
  // If the top-level schema has a custom JSON schema, use it directly
  const topLevel = customJsonSchemaOf(schema);
  if (topLevel) {
    return topLevel;
  }

  // Use override to handle nested custom types (like zObjectId, zDateOrString)
  return z.toJSONSchema(schema, {
    unrepresentable: "any",
    override: (ctx) => {
      const custom = customJsonSchemaOf(ctx.zodSchema);
      if (custom) {
        // Zod 4 expects the override to mutate ctx.jsonSchema in place
        for (const key of Object.keys(ctx.jsonSchema)) {
          delete (ctx.jsonSchema as Record<string, unknown>)[key];
        }
        Object.assign(ctx.jsonSchema, custom);
      }
    },
  }) as Record<string, unknown>;
}

function extractActionDescription(
  schema: any,
  actionValue: string,
): string | undefined {
  const def = schema._def || schema.def;
  if (def?.type === "object") {
    const shape = def.shape;
    const actionField = shape?.action;
    if (actionField) {
      const actionDef = actionField._def || actionField.def;
      if (
        actionDef?.type === "literal" && actionDef.values?.[0] === actionValue
      ) {
        return actionDef.description || actionField.description;
      }
    }
  }
  return undefined;
}

export function resourceToTools<Input, Output>(
  resource: Resource<Input, Output>,
  auth: Auth,
  options: ToolAdapterOptions,
): Record<
  string,
  {
    description?: string;
    inputSchema: any;
    execute: (args: any) => Promise<any>;
    needsApproval?: boolean;
  }
> {
  if (!options?.resourceManager) {
    throw new Error("A ResourceManager is required to execute resource tools");
  }
  const toolsRequiringApproval = new Set(options?.toolsRequiringApproval ?? []);
  const toolFilter = options?.toolFilter;
  const schema = resource.schemas.request;
  const def = schema.def as any;
  const tools: Record<
    string,
    {
      description?: string;
      inputSchema: any;
      execute: (args: any) => Promise<any>;
      needsApproval?: boolean;
    }
  > = {};

  if ((def?.type === "union")) {
    const discriminator = def.discriminator;
    const unionOptions = def.optionsMap
      ? Array.from(def.optionsMap.values())
      : def.options;
    // Distinguish "no union actions recognized" (→ fallback below) from
    // "actions recognized but excluded by toolFilter" (→ return what's left).
    let recognizedAnyAction = false;

    for (const optionSchema of unionOptions as z.ZodObject<any>[]) {
      const shape = optionSchema.shape;

      if (shape && shape[discriminator]) {
        const discriminatorField = shape[discriminator];
        const actionDef = discriminatorField.def;

        if (actionDef?.values?.length !== 1) {
          throw new Error(
            `Expected 1 value for discriminator ${discriminator}, got ${
              JSON.stringify(actionDef)
            }`,
          );
        }
        const actionValue = actionDef?.values?.[0];

        if (actionValue) {
          recognizedAnyAction = true;
          const toolName = `${
            resource.code.replace(/\./g, "_")
          }_${actionValue}`;
          if (toolFilter && !toolFilter(toolName)) {
            continue;
          }
          const actionDescription = extractActionDescription(
            optionSchema,
            actionValue,
          );

          let inputSchema = optionSchema;
          if (inputSchema instanceof z.ZodObject) {
            inputSchema = inputSchema.omit({ [discriminator]: true });
          } else {
            if ((inputSchema as any).omit) {
              inputSchema = (inputSchema as any).omit({
                [discriminator]: true,
              });
            }
          }

          tools[toolName] = {
            description: actionDescription || resource.description ||
              actionValue,
            inputSchema: inputSchema,
            needsApproval: toolsRequiringApproval.has(toolName),
            execute: async (args: any) => {
              const rawInput = {
                ...args,
                [discriminator]: actionValue,
              };
              // Parse through schema to apply Zod transforms (e.g., string → Date)
              const input = resource.schemas.request.parse(rawInput);
              options.validateInput?.(toolName, input);
              const result = await executeResource(
                resource,
                input as Input,
                auth,
                options?.resourceManager,
              );
              // Return in AI SDK outputSchema format with EJSON serialization for ObjectIds
              return serializeResult(result);
            },
          };
        }
      }
    }

    if (recognizedAnyAction) {
      return tools;
    }
  }

  if (toolFilter && !toolFilter(resource.code)) {
    return tools;
  }

  tools[resource.code] = {
    description: resource.description,
    inputSchema: schema,
    needsApproval: toolsRequiringApproval.has(resource.code),
    execute: async (args: any) => {
      // Parse through schema to apply Zod transforms (e.g., string → Date)
      const input = resource.schemas.request.parse(args);
      options.validateInput?.(resource.code, input);
      const result = await executeResource(
        resource,
        input,
        auth,
        options?.resourceManager,
      );
      // Return in AI SDK outputSchema format with EJSON serialization for ObjectIds
      return serializeResult(result);
    },
  };
  return tools;
}

export function createMCPToolsFromResources(
  resources: Resource<any, any>[],
  auth: Auth,
  options: ToolAdapterOptions,
): Record<
  string,
  {
    description?: string;
    inputSchema: any;
    execute: (args: any) => Promise<any>;
    needsApproval?: boolean;
  }
> {
  let allTools: Record<
    string,
    {
      description?: string;
      inputSchema: any;
      execute: (args: any) => Promise<any>;
      needsApproval?: boolean;
    }
  > = {};
  for (const resource of resources) {
    const resourceTools = resourceToTools(resource, auth, options);
    allTools = { ...allTools, ...resourceTools };
  }
  return allTools;
}

export function createAiSdkToolsFromResources(
  resources: Resource<any, any>[],
  auth: Auth,
  options: ToolAdapterOptions,
): Record<string, Tool> {
  const tools = createMCPToolsFromResources(resources, auth, options);
  const aiSdkTools: Record<string, Tool> = {};
  for (const [name, params] of Object.entries(tools)) {
    try {
      const jsonSchemaObj = zodSchemaToJsonSchema(params.inputSchema);
      aiSdkTools[name] = tool({
        description: params.description,
        inputSchema: jsonSchema(jsonSchemaObj as any),
        needsApproval: params.needsApproval ?? false,
        execute: params.execute,
      });
    } catch (err) {
      console.warn(
        `[ai-sdk-adapter] Failed to create tool ${name}:`,
        (err as Error).message,
      );
    }
  }
  return aiSdkTools;
}

export function resourceToAiSdkTools<Input, Output>(
  resource: Resource<Input, Output>,
  auth: Auth,
  options: ToolAdapterOptions,
): Record<string, Tool> {
  const tools = resourceToTools(resource, auth, options);
  const aiSdkTools: Record<string, Tool> = {};
  for (const [name, params] of Object.entries(tools)) {
    try {
      const jsonSchemaObj = zodSchemaToJsonSchema(params.inputSchema);
      aiSdkTools[name] = tool({
        description: params.description,
        inputSchema: jsonSchema(jsonSchemaObj as any),
        needsApproval: params.needsApproval ?? false,
        execute: params.execute,
      });
    } catch (err) {
      console.warn(
        `[ai-sdk-adapter] Failed to create tool ${name}:`,
        (err as Error).message,
      );
    }
  }
  return aiSdkTools;
}
