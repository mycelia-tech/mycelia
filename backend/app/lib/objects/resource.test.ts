import { expect } from "@std/expect";
import { Auth } from "@/lib/auth/core.server.ts";
import { withFixtures } from "@/tests/fixtures.server.ts";
import {
  getObjectsResource as getObjectsResourceFn,
  type ObjectsRequest,
  ObjectsResource,
  type ObjectsResponse,
} from "@/lib/objects/resource.server.ts";
import { ObjectId } from "bson";
import { ObjectId as MongoObjectId } from "mongodb";

async function getObjectsResource(auth: Auth) {
  return getObjectsResourceFn(auth);
}

Deno.test(
  "objects resource is registered",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const resource = await getObjectsResource(admin);
    expect(resource).toBeDefined();
  }),
);

Deno.test(
  "create object with basic fields",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const result = await objectsResource({
      action: "create",
      object: {
        name: "Test Object",
        details: "This is a test object",
        icon: { text: "📦" },
        color: "#ff0000",
      },
    });

    expect(result.insertedId).toBeDefined();
    expect(result.insertedId).toBeInstanceOf(MongoObjectId);

    await new Promise((resolve) => setTimeout(resolve, 50));
  }),
);

Deno.test(
  "create object with custom fields (passthrough)",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const result = await objectsResource({
      action: "create",
      object: {
        name: "Object with Custom Fields",
        customField1: "custom value",
        customField2: 42,
        nestedCustom: {
          foo: "bar",
        },
      },
    });

    expect(result.insertedId).toBeDefined();

    const retrieved = await objectsResource({
      action: "get",
      id: result.insertedId.toString(),
    });

    expect(retrieved.name).toBe("Object with Custom Fields");
    expect(retrieved.customField1).toBe("custom value");
    expect(retrieved.customField2).toBe(42);
    expect(retrieved.nestedCustom).toEqual({ foo: "bar" });
  }),
);

Deno.test(
  "get object returns version 0 for objects without version",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const createResult = await objectsResource({
      action: "create",
      object: {
        name: "Test Object",
      },
    });

    const retrieved = await objectsResource({
      action: "get",
      id: createResult.insertedId.toString(),
    });

    expect(retrieved.version).toBe(1);
    expect(retrieved.name).toBe("Test Object");
  }),
);

Deno.test(
  "update object field with correct version",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const createResult = await objectsResource({
      action: "create",
      object: {
        name: "Original Name",
        details: "Original details",
      },
    });

    const updated = await objectsResource({
      action: "update",
      id: createResult.insertedId.toString(),
      version: 1,
      field: "name",
      value: "Updated Name",
    });

    expect(updated.name).toBe("Updated Name");
    expect(updated.details).toBe("Original details");
    expect(updated.version).toBe(2);
  }),
);

Deno.test(
  "update nested field",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const subjectId = new ObjectId();
    const objectId = new ObjectId();

    const createResult = await objectsResource({
      action: "create",
      object: {
        name: "Test",
        relationship: {
          subject: subjectId.toString() as any,
          object: objectId.toString() as any,
          symmetrical: false,
        },
      },
    });

    const updated = await objectsResource({
      action: "update",
      id: createResult.insertedId.toString(),
      version: 1,
      field: "relationship.symmetrical",
      value: true,
    });

    expect(updated.relationship.symmetrical).toBe(true);
    expect(updated.version).toBe(2);
  }),
);

Deno.test(
  "update with wrong version throws 409 conflict",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const createResult = await objectsResource({
      action: "create",
      object: {
        name: "Test Object",
      },
    });

    try {
      await objectsResource({
        action: "update",
        id: createResult.insertedId.toString(),
        version: 999,
        field: "name",
        value: "This should fail",
      });
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.code).toBe(409);
      expect(error.message).toContain("modified by another user");
      expect(error.current).toBe(1);
      expect(error.expected).toBe(999);
      expect(error.latestObject).toBeDefined();
    }
  }),
);

Deno.test(
  "concurrent updates: second update fails with conflict",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const createResult = await objectsResource({
      action: "create",
      object: {
        name: "Test",
        details: "Original",
      },
    });

    await objectsResource({
      action: "update",
      id: createResult.insertedId.toString(),
      version: 1,
      field: "name",
      value: "First Update",
    });

    try {
      await objectsResource({
        action: "update",
        id: createResult.insertedId.toString(),
        version: 1,
        field: "details",
        value: "Second Update",
      });
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.code).toBe(409);
      expect(error.current).toBe(2);
    }
  }),
);

Deno.test(
  "delete object",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const createResult = await objectsResource({
      action: "create",
      object: {
        name: "To Delete",
      },
    });

    const deleteResult = await objectsResource({
      action: "delete",
      id: createResult.insertedId.toString(),
    });

    expect(deleteResult.deletedCount).toBe(1);

    const tombstone = await objectsResource({
      action: "get",
      id: createResult.insertedId.toString(),
    });
    expect(tombstone.deleted).toBe(true);
    expect(tombstone.name).toBe("To Delete");
    expect(tombstone.deletedBy).toBe(admin.principal);
  }),
);

Deno.test(
  "list objects with filters",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    await objectsResource({
      action: "create",
      object: { name: "Person 1", isPerson: true },
    });

    await objectsResource({
      action: "create",
      object: { name: "Event 1", isEvent: true },
    });

    await objectsResource({
      action: "create",
      object: { name: "Person 2", isPerson: true },
    });

    const people = await objectsResource({
      action: "list",
      filters: { isPerson: true },
    });

    expect(people).toHaveLength(2);
    expect(people.every((p: any) => p.isPerson)).toBe(true);
  }),
);

Deno.test(
  "list objects with search term",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    await objectsResource({
      action: "create",
      object: { name: "JavaScript Developer" },
    });

    await objectsResource({
      action: "create",
      object: { name: "Python Developer" },
    });

    await objectsResource({
      action: "create",
      object: { name: "JavaScript Framework" },
    });

    const results = await objectsResource({
      action: "list",
      options: {
        searchTerm: "JavaScript",
      },
    });

    expect(results).toHaveLength(2);
    expect(results.every((r: any) => r.name.includes("JavaScript"))).toBe(true);
  }),
);

Deno.test(
  "list objects with hasTimeRanges filter",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    await objectsResource({
      action: "create",
      object: {
        name: "Object 1",
        timeRanges: [{ start: new Date(), end: new Date() }],
      },
    });

    await objectsResource({
      action: "create",
      object: { name: "Object 2" },
    });

    const withTimeRanges = await objectsResource({
      action: "list",
      options: {
        hasTimeRanges: true,
      },
    });

    expect(withTimeRanges).toHaveLength(1);
    expect(withTimeRanges[0].name).toBe("Object 1");
  }),
);

Deno.test(
  "list objects with pagination",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    for (let i = 0; i < 10; i++) {
      await objectsResource({
        action: "create",
        object: { name: `Object ${i}` },
      });
    }

    const firstPage = await objectsResource({
      action: "list",
      options: {
        limit: 3,
        skip: 0,
      },
    });

    const secondPage = await objectsResource({
      action: "list",
      options: {
        limit: 3,
        skip: 3,
      },
    });

    expect(firstPage).toHaveLength(3);
    expect(secondPage).toHaveLength(3);
    expect(firstPage[0]._id).not.toEqual(secondPage[0]._id);
  }),
);

Deno.test(
  "Timeline view returns a bounded compact relationship response",
  withFixtures(["Admin", "Mongo", "Migrations"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);
    const subject = await objectsResource({
      action: "create",
      object: { name: "Subject", icon: { text: "👤" } },
    });
    const target = await objectsResource({
      action: "create",
      object: { name: "Target", icon: { text: "📍" } },
    });

    await objectsResource({
      action: "create",
      object: {
        name: "Older event",
        isEvent: true,
        timeRanges: [{
          start: new Date("2026-08-01T10:00:00.000Z"),
          end: new Date("2026-08-01T11:00:00.000Z"),
        }],
      },
    });
    await objectsResource({
      action: "create",
      object: {
        name: "Recent relationship",
        details: "Visible in the selected-object card",
        isRelationship: true,
        relationship: {
          subject: subject.insertedId.toString(),
          object: target.insertedId.toString(),
          symmetrical: false,
        },
        timeRanges: [{
          start: new Date("2026-08-02T10:00:00.000Z"),
          end: new Date("2026-08-02T11:00:00.000Z"),
        }],
        largeInternalPayload: "x".repeat(10_000),
      },
    });

    const result = await (objectsResource as any)({
      action: "list",
      view: "timeline",
      options: {
        includeRelationships: true,
        hasTimeRanges: true,
        limit: 1,
        sort: { earliestStart: -1, duration: -1 },
        timeRangeFilter: {
          start: "2026-08-01T00:00:00.000Z",
          end: "2026-08-03T00:00:00.000Z",
        },
      },
    });

    expect(result.truncated).toBe(true);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].name).toBe("Recent relationship");
    expect(result.objects[0].details).toBe(
      "Visible in the selected-object card",
    );
    expect(result.objects[0].largeInternalPayload).toBeUndefined();
    expect(result.objects[0].subjectObject).toEqual({
      _id: subject.insertedId,
      name: "Subject",
      icon: { text: "👤" },
    });
    expect(result.objects[0].objectObject).toEqual({
      _id: target.insertedId,
      name: "Target",
      icon: { text: "📍" },
    });
  }),
);

Deno.test(
  "full object list keeps the legacy array response",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);
    await objectsResource({
      action: "create",
      object: {
        name: "Legacy list object",
        timeRanges: [{ start: new Date("2026-08-01T10:00:00.000Z") }],
      },
    });

    const result = await objectsResource({
      action: "list",
      options: { hasTimeRanges: true, includeRelationships: true },
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].name).toBe("Legacy list object");
  }),
);

Deno.test(
  "getRelationships returns relationships for an object",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const person1 = await objectsResource({
      action: "create",
      object: { name: "Alice", isPerson: true },
    });

    const person2 = await objectsResource({
      action: "create",
      object: { name: "Bob", isPerson: true },
    });

    const relationship = await objectsResource({
      action: "create",
      object: {
        name: "Friends",
        isRelationship: true,
        relationship: {
          subject: person1.insertedId.toString(),
          object: person2.insertedId.toString(),
          symmetrical: true,
        },
        timeRanges: [{ start: new Date() }],
      },
    });

    const relationships = await objectsResource({
      action: "getRelationships",
      id: person1.insertedId.toString(),
    });

    expect(relationships).toHaveLength(1);
    expect(relationships[0].relationship.name).toBe("Friends");
    expect(relationships[0].other._id).toEqual(person2.insertedId);
  }),
);

Deno.test(
  "getHistory returns change history",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const createResult = await objectsResource({
      action: "create",
      object: {
        name: "Original",
        details: "First version",
      },
    });

    const id = createResult.insertedId.toString();

    await objectsResource({
      action: "update",
      id,
      version: 1,
      field: "name",
      value: "Updated Name",
    });

    await objectsResource({
      action: "update",
      id,
      version: 2,
      field: "details",
      value: "Updated Details",
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const history = await objectsResource({
      action: "getHistory",
      id,
    });

    expect(history.length).toBeGreaterThanOrEqual(3);

    const createEntry = history.find((h: any) => h.action === "create");
    expect(createEntry).toBeDefined();
    expect(createEntry.userId).toBe(admin.principal);
    expect(createEntry.version).toBe(1);

    const nameUpdate = history.find(
      (h: any) => h.action === "update" && h.field === "name",
    );
    expect(nameUpdate).toBeDefined();
    expect(nameUpdate.oldValue).toBe("Original");
    expect(nameUpdate.newValue).toBe("Updated Name");
    expect(nameUpdate.version).toBe(2);

    const detailsUpdate = history.find(
      (h: any) => h.action === "update" && h.field === "details",
    );
    expect(detailsUpdate).toBeDefined();
    expect(detailsUpdate.oldValue).toBe("First version");
    expect(detailsUpdate.newValue).toBe("Updated Details");
    expect(detailsUpdate.version).toBe(3);
  }),
);

Deno.test(
  "getHistory with pagination",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const createResult = await objectsResource({
      action: "create",
      object: { name: "Test" },
    });

    const id = createResult.insertedId.toString();

    for (let i = 0; i < 10; i++) {
      await objectsResource({
        action: "update",
        id,
        version: i + 1,
        field: "name",
        value: `Update ${i}`,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    const firstPage = await objectsResource({
      action: "getHistory",
      id,
      limit: 5,
      skip: 0,
    });

    const secondPage = await objectsResource({
      action: "getHistory",
      id,
      limit: 5,
      skip: 5,
    });

    expect(firstPage).toHaveLength(5);
    expect(secondPage).toHaveLength(5);
    expect(firstPage[0].timestamp.getTime()).toBeGreaterThan(
      secondPage[0].timestamp.getTime(),
    );
  }),
);

Deno.test(
  "list with includeRelationships performs lookups",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const subject = await objectsResource({
      action: "create",
      object: { name: "Subject", icon: { text: "👤" } },
    });

    const object = await objectsResource({
      action: "create",
      object: { name: "Object", icon: { text: "📦" } },
    });

    await objectsResource({
      action: "create",
      object: {
        name: "Relationship",
        isRelationship: true,
        isEvent: true,
        relationship: {
          subject: subject.insertedId.toString(),
          object: object.insertedId.toString(),
          symmetrical: false,
        },
        timeRanges: [{ start: new Date() }],
      },
    });

    const results = await objectsResource({
      action: "list",
      options: {
        hasTimeRanges: true,
        includeRelationships: true,
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0].subjectObject).toBeDefined();
    expect(results[0].objectObject).toBeDefined();
    expect(results[0].subjectObject.name).toBe("Subject");
    expect(results[0].objectObject.name).toBe("Object");
  }),
);

Deno.test(
  "delete records history",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const createResult = await objectsResource({
      action: "create",
      object: { name: "To Delete" },
    });

    const id = createResult.insertedId.toString();

    await objectsResource({
      action: "delete",
      id,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const history = await objectsResource({
      action: "getHistory",
      id,
    });

    const deleteEntry = history.find((h: any) => h.action === "delete");
    expect(deleteEntry).toBeDefined();
    expect(deleteEntry.userId).toBe(admin.principal);
    expect(deleteEntry.field).toBeNull();
  }),
);

// ============================================================================
// Type counts: new place/organization/product/project flags
// ============================================================================

Deno.test(
  "counts include new type flags and exclude them from other",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    await objectsResource({
      action: "create",
      object: { name: "Amsterdam", isPlace: true },
    });
    await objectsResource({
      action: "create",
      object: { name: "Anthropic", isOrganization: true },
    });
    await objectsResource({
      action: "create",
      object: { name: "Mycelia", isProduct: true },
    });
    await objectsResource({
      action: "create",
      object: { name: "Rebrand", isProject: true },
    });
    await objectsResource({
      action: "create",
      object: { name: "Untyped thing" },
    });

    const counts = await objectsResource({
      action: "getCounts",
      forceRefresh: true,
    });

    expect(counts.place).toBe(1);
    expect(counts.organization).toBe(1);
    expect(counts.product).toBe(1);
    expect(counts.project).toBe(1);
    expect(counts.other).toBe(1);
  }),
);

// ============================================================================
// Merge
// ============================================================================

Deno.test(
  "merge unions fields and aliases into the winner",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const a = await objectsResource({
      action: "create",
      object: { name: "Igor", aliases: ["Gosha"], isPerson: true },
    });
    const b = await objectsResource({
      action: "create",
      object: {
        name: "igor",
        aliases: ["Igor K."],
        starred: true,
        details: "From work",
      },
    });

    const result = await objectsResource({
      action: "merge",
      winnerId: a.insertedId.toString(),
      loserIds: [b.insertedId.toString()],
      canonicalName: "Igor",
      version: 1,
    });

    expect(result.mergedIds).toEqual([b.insertedId.toString()]);
    const winner = result.winner;
    expect(winner.name).toBe("Igor");
    expect(winner.aliases).toContain("Gosha");
    expect(winner.aliases).toContain("Igor K.");
    // Case-insensitive duplicate of the canonical name is not an alias
    expect(winner.aliases).not.toContain("igor");
    expect(winner.starred).toBe(true);
    expect(winner.isPerson).toBe(true);
    expect(winner.details).toBe("From work");
    expect(winner.version).toBe(2);
    expect(winner.metadata.mergedFrom).toHaveLength(1);
    expect(winner.metadata.mergedFrom[0].name).toBe("igor");

    const tombstone = await objectsResource({
      action: "get",
      id: b.insertedId.toString(),
    });
    expect(tombstone.deleted).toBe(true);
    expect(tombstone.mergedInto).toBe(a.insertedId.toString());
  }),
);

Deno.test(
  "merge re-points edges, drops self-edges and dedupes",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const a = await objectsResource({
      action: "create",
      object: { name: "A", isPerson: true },
    });
    const b = await objectsResource({
      action: "create",
      object: { name: "B", isPerson: true },
    });
    const c = await objectsResource({
      action: "create",
      object: { name: "C", isPerson: true },
    });

    const edge = (subject: ObjectId, object: ObjectId, name: string) =>
      objectsResource({
        action: "create",
        object: {
          name,
          isRelationship: true,
          relationship: { subject, object, symmetrical: false },
        },
      });

    await edge(a.insertedId, c.insertedId, "knows"); // duplicate after merge
    await edge(b.insertedId, c.insertedId, "knows");
    await edge(a.insertedId, b.insertedId, "knows"); // becomes self-edge

    const result = await objectsResource({
      action: "merge",
      winnerId: a.insertedId.toString(),
      loserIds: [b.insertedId.toString()],
    });

    expect(result.edgesRepointed).toBeGreaterThanOrEqual(2);
    expect(result.edgesDeduped).toBe(1);

    const relationships = await objectsResource({
      action: "getRelationships",
      id: a.insertedId.toString(),
    });
    // Only one edge should remain: A -knows-> C
    expect(relationships).toHaveLength(1);
    expect(relationships[0].other._id.toString()).toBe(
      c.insertedId.toString(),
    );
  }),
);

Deno.test(
  "merge validations reject bad input",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const a = await objectsResource({
      action: "create",
      object: { name: "A" },
    });
    const rel = await objectsResource({
      action: "create",
      object: {
        name: "edge",
        isRelationship: true,
        relationship: {
          subject: a.insertedId,
          object: a.insertedId,
          symmetrical: false,
        },
      },
    });

    await expect(objectsResource({
      action: "merge",
      winnerId: a.insertedId.toString(),
      loserIds: [a.insertedId.toString()],
    })).rejects.toThrow("Winner cannot be one of the merged objects");

    await expect(objectsResource({
      action: "merge",
      winnerId: a.insertedId.toString(),
      loserIds: [rel.insertedId.toString()],
    })).rejects.toThrow("not supported");

    await expect(objectsResource({
      action: "merge",
      winnerId: a.insertedId.toString(),
      loserIds: [new ObjectId().toString()],
    })).rejects.toThrow("Objects not found");

    const b = await objectsResource({
      action: "create",
      object: { name: "B" },
    });
    let conflict: any;
    try {
      await objectsResource({
        action: "merge",
        winnerId: a.insertedId.toString(),
        loserIds: [b.insertedId.toString()],
        version: 99,
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict?.code).toBe(409);
  }),
);

Deno.test(
  "merge preserves loser document in history",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const a = await objectsResource({
      action: "create",
      object: { name: "Keeper" },
    });
    const b = await objectsResource({
      action: "create",
      object: { name: "Loser", details: "precious data" },
    });

    await objectsResource({
      action: "merge",
      winnerId: a.insertedId.toString(),
      loserIds: [b.insertedId.toString()],
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const loserHistory = await objectsResource({
      action: "getHistory",
      id: b.insertedId.toString(),
    });
    const mergeEntry = loserHistory.find((h: any) => h.action === "merge");
    expect(mergeEntry).toBeDefined();
    expect(mergeEntry.field).toBe("mergedInto");
    expect(mergeEntry.oldValue.details).toBe("precious data");

    const winnerHistory = await objectsResource({
      action: "getHistory",
      id: a.insertedId.toString(),
    });
    expect(winnerHistory.some((h: any) => h.action === "merge")).toBe(true);
  }),
);

// ============================================================================
// Split
// ============================================================================

Deno.test(
  "split moves selected edges and aliases to a new object",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const source = await objectsResource({
      action: "create",
      object: {
        name: "Igor",
        aliases: ["Gosha", "Igor W."],
        isPerson: true,
      },
    });
    const c = await objectsResource({
      action: "create",
      object: { name: "C" },
    });
    const d = await objectsResource({
      action: "create",
      object: { name: "D" },
    });

    await objectsResource({
      action: "create",
      object: {
        name: "knows",
        isRelationship: true,
        relationship: {
          subject: source.insertedId,
          object: c.insertedId,
          symmetrical: false,
        },
      },
    });
    const edgeToMove = await objectsResource({
      action: "create",
      object: {
        name: "works with",
        isRelationship: true,
        relationship: {
          subject: source.insertedId,
          object: d.insertedId,
          symmetrical: false,
        },
      },
    });

    const result = await objectsResource({
      action: "split",
      sourceId: source.insertedId.toString(),
      newObject: { name: "Igor (work)" },
      edgeIdsToMove: [edgeToMove.insertedId.toString()],
      aliasesToMove: ["Igor W."],
      version: 1,
    });

    expect(result.movedEdges).toBe(1);
    expect(result.movedAliases).toEqual(["Igor W."]);
    expect(result.source.aliases).toEqual(["Gosha"]);
    expect(result.source.version).toBe(2);

    const newObject = await objectsResource({
      action: "get",
      id: result.newId.toString(),
    });
    expect(newObject.name).toBe("Igor (work)");
    expect(newObject.isPerson).toBe(true);
    expect(newObject.aliases).toEqual(["Igor W."]);
    expect(newObject.metadata.splitFrom.name).toBe("Igor");

    const newRelationships = await objectsResource({
      action: "getRelationships",
      id: result.newId.toString(),
    });
    expect(newRelationships).toHaveLength(1);
    expect(newRelationships[0].other._id.toString()).toBe(
      d.insertedId.toString(),
    );

    const sourceRelationships = await objectsResource({
      action: "getRelationships",
      id: source.insertedId.toString(),
    });
    expect(sourceRelationships).toHaveLength(1);
    expect(sourceRelationships[0].other._id.toString()).toBe(
      c.insertedId.toString(),
    );
  }),
);

Deno.test(
  "split validations reject foreign edges and relationship sources",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const a = await objectsResource({
      action: "create",
      object: { name: "A" },
    });
    const b = await objectsResource({
      action: "create",
      object: { name: "B" },
    });
    const c = await objectsResource({
      action: "create",
      object: { name: "C" },
    });
    const foreignEdge = await objectsResource({
      action: "create",
      object: {
        name: "knows",
        isRelationship: true,
        relationship: {
          subject: b.insertedId,
          object: c.insertedId,
          symmetrical: false,
        },
      },
    });

    await expect(objectsResource({
      action: "split",
      sourceId: a.insertedId.toString(),
      newObject: { name: "A2" },
      edgeIdsToMove: [foreignEdge.insertedId.toString()],
      aliasesToMove: [],
    })).rejects.toThrow("does not involve the source object");

    await expect(objectsResource({
      action: "split",
      sourceId: foreignEdge.insertedId.toString(),
      newObject: { name: "X" },
      edgeIdsToMove: [],
      aliasesToMove: [],
    })).rejects.toThrow("not supported");
  }),
);

// ============================================================================
// findDuplicates
// ============================================================================

Deno.test(
  "findDuplicates matches case-insensitive names and aliases for one object",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    const target = await objectsResource({
      action: "create",
      object: { name: "Igor", aliases: ["Gosha"] },
    });
    await objectsResource({
      action: "create",
      object: { name: "igor" },
    });
    await objectsResource({
      action: "create",
      object: { name: "Somebody", aliases: ["GOSHA"] },
    });
    await objectsResource({
      action: "create",
      object: { name: "Unrelated" },
    });

    const result = await objectsResource({
      action: "findDuplicates",
      objectId: target.insertedId.toString(),
    });

    const names = result.candidates.map((c: any) => c.name).sort();
    expect(names).toEqual(["Somebody", "igor"]);
  }),
);

Deno.test(
  "findDuplicates scan groups collisions across the collection",
  withFixtures(["Admin", "Mongo"], async (admin: Auth) => {
    const objectsResource = await getObjectsResource(admin);

    await objectsResource({
      action: "create",
      object: { name: "Shushi" },
    });
    await objectsResource({
      action: "create",
      object: { name: "shushi" },
    });
    await objectsResource({
      action: "create",
      object: { name: "Solo" },
    });

    const result = await objectsResource({ action: "findDuplicates" });

    const group = result.groups.find((g: any) => g.key === "shushi");
    expect(group).toBeDefined();
    expect(group.count).toBe(2);
    expect(result.groups.some((g: any) => g.key === "solo")).toBe(false);
  }),
);

Deno.test("reviveTimeRangeDates converts ISO strings to Dates", async () => {
  const { reviveTimeRangeDates } = await import("./resource.server.ts");
  const revived = reviveTimeRangeDates([
    { start: "2026-08-07T10:00:00Z", end: "2026-08-07T11:00:00Z" },
  ]);
  if (!(revived[0].start instanceof Date) || !(revived[0].end instanceof Date)) {
    throw new Error("timeRanges dates were not revived to Date");
  }
  const bare = reviveTimeRangeDates("2026-08-07T10:00:00Z");
  if (!(bare instanceof Date)) {
    throw new Error("dotted-path string value was not revived to Date");
  }
  const untouched = reviveTimeRangeDates([{ start: new Date(0), note: "x" }]);
  if (untouched[0].note !== "x" || !(untouched[0].start instanceof Date)) {
    throw new Error("existing values must pass through");
  }
});
