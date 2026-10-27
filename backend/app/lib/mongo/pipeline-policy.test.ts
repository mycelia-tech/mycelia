import { expect } from "@std/expect";
import { Auth } from "@/lib/auth/core.server.ts";
import { ResourceManager } from "@/lib/auth/resources.ts";
import { MongoResource } from "./core.server.ts";
import { aggregateResourceActions } from "./pipeline-policy.ts";

const reader = new Auth({
  principal: "reader",
  policies: [{ resource: "db/public", action: "read", effect: "allow" }],
});

Deno.test("aggregation checks nested lookup, graph lookup and union collections", async () => {
  const resource = new MongoResource();
  const actions = resource.extractActions({
    action: "aggregate",
    collection: "public",
    pipeline: [
      {
        $facet: {
          joined: [{
            $lookup: {
              from: "other",
              pipeline: [{ $unionWith: "secret" }],
              as: "items",
            },
          }],
        },
      },
      {
        $graphLookup: {
          from: "graph",
          startWith: "$id",
          connectFromField: "id",
          connectToField: "id",
          as: "graph",
        },
      },
    ],
  });
  expect(actions).toEqual([
    { path: ["db", "public"], actions: ["read"] },
    { path: ["db", "other"], actions: ["read"] },
    { path: ["db", "secret"], actions: ["read"] },
    { path: ["db", "graph"], actions: ["read"] },
  ]);
  await expect(new ResourceManager().matchPolicies(reader, ...actions)).rejects
    .toBeInstanceOf(Response);
});

Deno.test("aggregation requires write permissions on output namespace", async () => {
  for (const output of [{ $out: "secret" }, { $merge: { into: "secret" } }]) {
    const actions = aggregateResourceActions("public", [output]);
    expect(actions).toEqual([
      { path: ["db", "public"], actions: ["read"] },
      { path: ["db", "secret"], actions: ["write", "update", "delete"] },
    ]);
    const auth = new Auth({
      principal: "writer",
      policies: [{ resource: "db/public", action: "*", effect: "allow" }],
    });
    await expect(new ResourceManager().matchPolicies(auth, ...actions)).rejects
      .toBeInstanceOf(Response);
  }
});

Deno.test("aggregation rejects unknown stages and cross-database output", () => {
  for (
    const pipeline of [[{ $out: { db: "another", coll: "secret" } }], [{
      $currentOp: {},
    }], [{ $lookup: { from: { db: "another", coll: "secret" }, as: "x" } }]]
  ) {
    let denied = false;
    try {
      aggregateResourceActions("public", pipeline);
    } catch (error) {
      denied = error instanceof Response && error.status === 403;
    }
    expect(denied).toBe(true);
  }
});

Deno.test("same-collection read aggregates remain available", async () => {
  const actions = aggregateResourceActions("public", [
    { $match: { active: true } },
    { $group: { _id: "$kind", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]);
  await new ResourceManager().ensureAllowed(reader, ...actions);
});

Deno.test("filtered credentials fail closed for aggregate and bulk write", async () => {
  const resource = new MongoResource();
  let executed = false;
  for (
    const input of [
      { action: "aggregate", collection: "public", pipeline: [] },
      {
        action: "bulkWrite",
        collection: "public",
        operations: [{ deleteMany: { filter: {} } }],
      },
    ] as const
  ) {
    await expect(
      resource.modifiers.filter.use({
        arg: { filter: { owner: "reader" } },
        auth: reader,
        input: input as any,
      }, async () => {
        executed = true;
      }),
    ).rejects.toBeInstanceOf(Response);
  }
  expect(executed).toBe(false);
});

Deno.test("bulk upsert uses Mongo driver's top-level flag for write authorization", () => {
  const actions = new MongoResource().extractActions({
    action: "bulkWrite",
    collection: "public",
    operations: [{
      updateOne: { filter: {}, update: { $set: { ok: true } }, upsert: true },
    }],
  });
  expect(actions[0].actions).toContain("write");
});

Deno.test("cursor continuation binds collection and credential policies", async () => {
  const resource = new MongoResource();
  const documents = [{ id: 1 }, { id: 2 }, { id: 3 }];
  resource.getRootDB = async () => ({
    collection: () => ({
      find: () => {
        let offset = 0;
        return {
          hasNext: async () => offset < documents.length,
          next: async () => documents[offset++],
          close: async () => {},
        };
      },
    }),
  } as any);
  resource.ensureCollectionExists = async () => {};
  const full = new Auth({
    principal: "same-owner",
    policies: [{ resource: "**", action: "*", effect: "allow" }],
  });
  const scoped = new Auth({
    principal: "same-owner",
    policies: [{ resource: "db/public", action: "read", effect: "allow" }],
  });
  const first = await resource.use({
    action: "getFirstBatch",
    collection: "private",
    query: {},
    batchSize: 1,
  }, full);
  expect(first.data).toEqual([{ id: 1 }]);
  expect(
    await resource.use({
      action: "getMore",
      collection: "public",
      cursorId: first.cursorId,
      batchSize: 1,
    }, full),
  ).toEqual({ data: [], hasMore: false });
  expect(
    await resource.use({
      action: "getMore",
      collection: "private",
      cursorId: first.cursorId,
      batchSize: 1,
    }, scoped),
  ).toEqual({ data: [], hasMore: false });
  expect(
    await resource.use({
      action: "closeCursor",
      collection: "private",
      cursorId: first.cursorId,
    }, scoped),
  ).toEqual({ closed: false });
  expect(
    await resource.use({
      action: "getMore",
      collection: "private",
      cursorId: first.cursorId,
      batchSize: 1,
    }, full),
  ).toEqual({ data: [{ id: 2 }], hasMore: true });
  expect(
    await resource.use({
      action: "closeCursor",
      collection: "private",
      cursorId: first.cursorId,
    }, full),
  ).toEqual({ closed: true });
});
