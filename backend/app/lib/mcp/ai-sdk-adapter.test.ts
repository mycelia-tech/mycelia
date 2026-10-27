import { expect } from "@std/expect";
import { z } from "zod";
import {
  createAiSdkToolsFromResources as createTools,
  resourceToAiSdkTools as createResourceTools,
  resourceToTools,
  type ToolAdapterOptions,
} from "./ai-sdk-adapter.ts";
import { Resource, ResourceManager } from "@/lib/auth/resources.ts";
import { accessLogger, Auth } from "@/lib/auth/core.server.ts";

// Exercise real policy enforcement without connecting the audit sink to Redis.
accessLogger.log = async () => {};

function managerFor(resources: Resource<any, any>[]) {
  const manager = new ResourceManager();
  resources.forEach((resource) => manager.registerResource(resource));
  return manager;
}

function resourceToAiSdkTools(
  resource: Resource<any, any>,
  auth: Auth,
  options: Partial<ToolAdapterOptions> = {},
) {
  return createResourceTools(resource, auth, {
    resourceManager: managerFor([resource]),
    ...options,
  });
}

function createAiSdkToolsFromResources(
  resources: Resource<any, any>[],
  auth: Auth,
  options: Partial<ToolAdapterOptions> = {},
) {
  return createTools(resources, auth, {
    resourceManager: managerFor(resources),
    ...options,
  });
}

Deno.test("tool generation refuses missing policy manager", () => {
  expect(() =>
    resourceToTools(
      new SimpleTestResource(),
      mockAuth,
      {} as ToolAdapterOptions,
    )
  ).toThrow("ResourceManager is required");
});

Deno.test("union tools enforce deny policies before resource use", async () => {
  const resource = new DiscriminatedUnionResource();
  let calls = 0;
  resource.use = async () => {
    calls++;
    return { result: "forbidden" };
  };
  const auth = new Auth({ principal: "restricted", policies: [] });
  const tools = resourceToTools(resource, auth, {
    resourceManager: managerFor([resource]),
  });
  await expect(tools.test_discriminated_get.execute({ id: "one" })).rejects
    .toBeInstanceOf(Response);
  expect(calls).toBe(0);
});

Deno.test("union tool execution preserves policy modifiers", async () => {
  const resource = new DiscriminatedUnionResource();
  const scopedResource = Object.assign(resource, {
    modifiers: {
      scoped: {
        use: async ({ input, auth }: any, next: any) =>
          next({ ...input, id: "scoped" }, auth),
      },
    },
  });
  const auth = new Auth({
    principal: "restricted",
    policies: [{
      resource: "test/**",
      action: "*",
      effect: "modify",
      middleware: { code: "scoped" },
    }],
  });
  const tools = resourceToTools(scopedResource, auth, {
    resourceManager: managerFor([scopedResource]),
  });
  expect(await tools.test_discriminated_get.execute({ id: "untrusted" }))
    .toEqual({ type: "json", value: { result: "Got scoped" } });
});

// Test resource with simple schema
class SimpleTestResource
  implements Resource<{ value: string }, { result: string }> {
  code = "test_simple";
  description = "Simple test resource";
  schemas = {
    request: z.object({ value: z.string() }),
    response: z.object({ result: z.string() }),
  };

  async use(
    input: { value: string },
    _auth: Auth,
  ): Promise<{ result: string }> {
    return { result: `Processed: ${input.value}` };
  }

  extractActions(_input: { value: string }) {
    return [{ path: ["test", "simple"], actions: ["read"] }];
  }
}

// Test resource with discriminated union
class DiscriminatedUnionResource implements
  Resource<
    | { action: "get"; id: string }
    | { action: "set"; id: string; value: string },
    { result: any }
  > {
  code = "test_discriminated";
  description = "Test discriminated union resource";
  schemas = {
    request: z.discriminatedUnion("action", [
      z.object({ action: z.literal("get"), id: z.string() }),
      z.object({ action: z.literal("set"), id: z.string(), value: z.string() }),
    ]),
    response: z.object({ result: z.any() }),
  };

  async use(
    input: { action: "get"; id: string } | {
      action: "set";
      id: string;
      value: string;
    },
    _auth: Auth,
  ): Promise<{ result: any }> {
    if (input.action === "get") {
      return { result: `Got ${input.id}` };
    }
    return { result: `Set ${input.id} to ${input.value}` };
  }

  extractActions(
    _input: { action: "get"; id: string } | {
      action: "set";
      id: string;
      value: string;
    },
  ) {
    return [{ path: ["test", "discriminated"], actions: ["read", "write"] }];
  }
}

const mockAuth = new Auth({
  principal: "test-user",
  policies: [
    {
      effect: "allow",
      resource: "test/**",
      action: "*",
    },
  ],
});

Deno.test("AI SDK Adapter - Simple resource creates valid tool schema", async () => {
  const resource = new SimpleTestResource();
  const tools = resourceToAiSdkTools(resource, mockAuth);

  expect(Object.keys(tools).length).toBe(1);
  const tool = tools["test_simple"];
  expect(tool).toBeDefined();
  expect(tool.execute).toBeDefined();

  // Test that the tool can be executed with the correct input
  if (!tool.execute) {
    throw new Error("tool.execute is undefined");
  }
  const result = await tool.execute(
    { value: "test" },
    { toolCallId: "test-call-id", messages: [] },
  );
  expect(result).toEqual({
    type: "json",
    value: { result: "Processed: test" },
  });
});

Deno.test("AI SDK Adapter - ResourceManager option enforces resource policy before tool use", async () => {
  const resource = new SimpleTestResource();
  const resourceManager = new ResourceManager();
  resourceManager.registerResource(resource);
  const deniedAuth = new Auth({ principal: "denied-user", policies: [] });
  const tools = resourceToAiSdkTools(resource, deniedAuth, {
    resourceManager,
  });
  const execute = tools.test_simple.execute;
  if (!execute) throw new Error("tool.execute is undefined");

  let thrown: unknown;
  try {
    await execute(
      { value: "must-not-run" },
      { toolCallId: "denied-call", messages: [] },
    );
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).status).toBe(403);
});

Deno.test("AI SDK Adapter - Discriminated union creates multiple tools with correct schemas", async () => {
  const resource = new DiscriminatedUnionResource();
  const tools = resourceToAiSdkTools(resource, mockAuth);

  expect(Object.keys(tools)).toEqual([
    "test_discriminated_get",
    "test_discriminated_set",
  ]);

  const getTool = tools["test_discriminated_get"];
  const setTool = tools["test_discriminated_set"];

  expect(getTool).toBeDefined();
  expect(setTool).toBeDefined();
  expect(getTool.execute).toBeDefined();
  expect(setTool.execute).toBeDefined();

  // Test that get tool works correctly (action discriminator should be omitted from input)
  if (!getTool.execute) {
    throw new Error("getTool.execute is undefined");
  }
  const getResult = await getTool.execute(
    { id: "test-id" },
    { toolCallId: "test-call-id-get", messages: [] },
  );
  expect(getResult).toEqual({ type: "json", value: { result: "Got test-id" } });

  // Test that set tool works correctly (action discriminator should be omitted from input)
  if (!setTool.execute) {
    throw new Error("setTool.execute is undefined");
  }
  const setResult = await setTool.execute(
    { id: "test-id", value: "test-value" },
    { toolCallId: "test-call-id-set", messages: [] },
  );
  expect(setResult).toEqual({
    type: "json",
    value: { result: "Set test-id to test-value" },
  });
});

// Tests for createAiSdkToolsFromResources (passes Zod schema to AI SDK)

Deno.test("createAiSdkToolsFromResources - Simple resource creates valid tool with Zod schema", async () => {
  const resource = new SimpleTestResource();
  const tools = createAiSdkToolsFromResources([resource], mockAuth);

  expect(Object.keys(tools).length).toBe(1);
  const tool = tools["test_simple"];
  expect(tool).toBeDefined();
  expect(tool.execute).toBeDefined();

  // Test that the tool can be executed with the correct input
  if (!tool.execute) {
    throw new Error("tool.execute is undefined");
  }
  const result = await tool.execute(
    { value: "test" },
    { toolCallId: "test-call-id", messages: [] },
  );
  expect(result).toEqual({
    type: "json",
    value: { result: "Processed: test" },
  });
});

Deno.test("createAiSdkToolsFromResources - Discriminated union creates multiple tools with Zod schemas", async () => {
  const resource = new DiscriminatedUnionResource();
  const tools = createAiSdkToolsFromResources([resource], mockAuth);

  expect(Object.keys(tools)).toEqual([
    "test_discriminated_get",
    "test_discriminated_set",
  ]);

  const getTool = tools["test_discriminated_get"];
  const setTool = tools["test_discriminated_set"];

  expect(getTool).toBeDefined();
  expect(setTool).toBeDefined();
  expect(getTool.inputSchema).toBeDefined();
  expect(setTool.inputSchema).toBeDefined();

  // Test execution
  if (!getTool.execute) {
    throw new Error("getTool.execute is undefined");
  }
  const getResult = await getTool.execute(
    { id: "test-id" },
    { toolCallId: "test-call-id-get", messages: [] },
  );
  expect(getResult).toEqual({ type: "json", value: { result: "Got test-id" } });

  if (!setTool.execute) {
    throw new Error("setTool.execute is undefined");
  }
  const setResult = await setTool.execute(
    { id: "test-id", value: "test-value" },
    { toolCallId: "test-call-id-set", messages: [] },
  );
  expect(setResult).toEqual({
    type: "json",
    value: { result: "Set test-id to test-value" },
  });
});

Deno.test("createAiSdkToolsFromResources - Multiple resources combined", async () => {
  const simpleResource = new SimpleTestResource();
  const discriminatedResource = new DiscriminatedUnionResource();

  const tools = createAiSdkToolsFromResources([
    simpleResource,
    discriminatedResource,
  ], mockAuth);

  expect(Object.keys(tools).sort()).toEqual([
    "test_discriminated_get",
    "test_discriminated_set",
    "test_simple",
  ]);

  // Verify all tools are executable
  expect(tools["test_simple"].execute).toBeDefined();
  expect(tools["test_discriminated_get"].execute).toBeDefined();
  expect(tools["test_discriminated_set"].execute).toBeDefined();
});

// Test resource with z.any() - common pattern in real resources
class ResourceWithAnySchema
  implements Resource<{ data: any }, { result: any }> {
  code = "test_any";
  description = "Test resource with z.any()";
  schemas = {
    request: z.object({ data: z.any() }),
    response: z.object({ result: z.any() }),
  };

  async use(input: { data: any }, _auth: Auth): Promise<{ result: any }> {
    return { result: input.data };
  }

  extractActions(_input: { data: any }) {
    return [{ path: ["test", "any"], actions: ["read"] }];
  }
}

Deno.test("createAiSdkToolsFromResources - Resource with z.any() field creates valid tool", async () => {
  const resource = new ResourceWithAnySchema();
  const tools = createAiSdkToolsFromResources([resource], mockAuth);

  expect(Object.keys(tools).length).toBe(1);
  const tool = tools["test_any"];
  expect(tool).toBeDefined();
  expect(tool.inputSchema).toBeDefined();

  // Test execution
  if (!tool.execute) {
    throw new Error("tool.execute is undefined");
  }
  const result = await tool.execute(
    { data: { nested: "value" } },
    { toolCallId: "test-call-id", messages: [] },
  );
  expect(result).toEqual({
    type: "json",
    value: { result: { nested: "value" } },
  });
});

// Test resource with optional fields
class ResourceWithOptionalFields implements
  Resource<
    { required: string; optional?: string },
    { result: string }
  > {
  code = "test_optional";
  description = "Test resource with optional fields";
  schemas = {
    request: z.object({
      required: z.string(),
      optional: z.string().optional(),
    }),
    response: z.object({ result: z.string() }),
  };

  async use(
    input: { required: string; optional?: string },
    _auth: Auth,
  ): Promise<{ result: string }> {
    return { result: `${input.required}-${input.optional ?? "none"}` };
  }

  extractActions(_input: { required: string; optional?: string }) {
    return [{ path: ["test", "optional"], actions: ["read"] }];
  }
}

Deno.test("createAiSdkToolsFromResources - Resource with optional fields works correctly", async () => {
  const resource = new ResourceWithOptionalFields();
  const tools = createAiSdkToolsFromResources([resource], mockAuth);

  const tool = tools["test_optional"];
  expect(tool).toBeDefined();
  expect(tool.inputSchema).toBeDefined();

  // Test execution with and without optional
  if (!tool.execute) {
    throw new Error("tool.execute is undefined");
  }

  const result1 = await tool.execute(
    { required: "test" },
    { toolCallId: "test-call-id-1", messages: [] },
  );
  expect(result1).toEqual({ type: "json", value: { result: "test-none" } });

  const result2 = await tool.execute(
    { required: "test", optional: "value" },
    { toolCallId: "test-call-id-2", messages: [] },
  );
  expect(result2).toEqual({ type: "json", value: { result: "test-value" } });
});

// Tests for tool approval mechanism

Deno.test("createAiSdkToolsFromResources - Tool approval mechanism for simple resource", () => {
  const resource = new SimpleTestResource();
  const tools = createAiSdkToolsFromResources([resource], mockAuth, {
    toolsRequiringApproval: ["test_simple"],
  });

  expect(tools["test_simple"]).toBeDefined();
  // needsApproval is a property on the tool object in AI SDK
  expect((tools["test_simple"] as any).needsApproval).toBe(true);
});

Deno.test("createAiSdkToolsFromResources - Tool approval mechanism for discriminated union", () => {
  const resource = new DiscriminatedUnionResource();
  const tools = createAiSdkToolsFromResources([resource], mockAuth, {
    toolsRequiringApproval: ["test_discriminated_set"],
  });

  expect(tools["test_discriminated_get"]).toBeDefined();
  expect((tools["test_discriminated_get"] as any).needsApproval).toBe(false);

  expect(tools["test_discriminated_set"]).toBeDefined();
  expect((tools["test_discriminated_set"] as any).needsApproval).toBe(true);
});

// Smoke tests with real resources from the codebase

import { MongoResource } from "@/lib/mongo/core.server.ts";
import { TimelineResource } from "@/lib/timeline/resource.server.ts";
import { ObjectsResource } from "@/lib/objects/resource.server.ts";

const realResourceAuth = new Auth({
  principal: "test-user",
  policies: [
    {
      effect: "allow",
      resource: "**",
      action: "*",
    },
  ],
});

Deno.test("createAiSdkToolsFromResources - Smoke test with MongoResource", () => {
  const resource = new MongoResource();
  const tools = createAiSdkToolsFromResources([resource], realResourceAuth);

  // MongoResource has a discriminated union with many actions
  const toolNames = Object.keys(tools);
  expect(toolNames.length).toBeGreaterThan(0);

  // Check that expected mongo tools exist
  expect(toolNames).toContain("mongo_find");
  expect(toolNames).toContain("mongo_findOne");
  expect(toolNames).toContain("mongo_insertOne");
  expect(toolNames).toContain("mongo_updateOne");
  expect(toolNames).toContain("mongo_deleteOne");

  // Verify all tools have valid parameters
  for (const [_name, tool] of Object.entries(tools)) {
    expect(tool.inputSchema).toBeDefined();
  }
});

Deno.test("createAiSdkToolsFromResources - Smoke test with TimelineResource", () => {
  const resource = new TimelineResource();
  const tools = createAiSdkToolsFromResources([resource], realResourceAuth);

  const toolNames = Object.keys(tools);
  expect(toolNames.length).toBeGreaterThan(0);

  // Check that expected timeline tools exist
  expect(toolNames).toContain("timeline_recalculate");
  expect(toolNames).toContain("timeline_ensureIndex");
  expect(toolNames).toContain("timeline_invalidate");

  // Verify all tools have valid parameters
  for (const [_name, tool] of Object.entries(tools)) {
    expect(tool.inputSchema).toBeDefined();
  }
});

Deno.test("createAiSdkToolsFromResources - Smoke test with ObjectsResource", () => {
  const resource = new ObjectsResource();
  const tools = createAiSdkToolsFromResources([resource], realResourceAuth);

  const toolNames = Object.keys(tools);
  expect(toolNames.length).toBeGreaterThan(0);

  // Check that expected objects tools exist (some may fail JSON Schema conversion due to custom types)
  expect(toolNames).toContain("objects_get");
  expect(toolNames).toContain("objects_list");
  expect(toolNames).toContain("objects_update");
  expect(toolNames).toContain("objects_delete");

  // Verify all tools have valid parameters
  for (const [_name, tool] of Object.entries(tools)) {
    expect(tool.inputSchema).toBeDefined();
  }
});

Deno.test("createAiSdkToolsFromResources - Smoke test with all real resources combined (as in api.chat)", () => {
  const mongoResource = new MongoResource();
  const timelineResource = new TimelineResource();
  const objectsResource = new ObjectsResource();

  const resources = [mongoResource, timelineResource, objectsResource];

  const tools = createAiSdkToolsFromResources(resources, realResourceAuth);

  const toolNames = Object.keys(tools);

  // Should have tools from all 3 resources
  expect(toolNames.some((n) => n.startsWith("mongo_"))).toBe(true);
  expect(toolNames.some((n) => n.startsWith("timeline_"))).toBe(true);
  expect(toolNames.some((n) => n.startsWith("objects_"))).toBe(true);

  // Verify all tools have valid parameters and are executable
  for (const [_name, tool] of Object.entries(tools)) {
    expect(tool.inputSchema).toBeDefined();
    expect(tool.execute).toBeDefined();
  }

  console.log(
    `Created ${toolNames.length} tools from real resources:`,
    toolNames.sort(),
  );
});
