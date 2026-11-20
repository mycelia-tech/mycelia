import { expect } from "@std/expect";
import { ObjectId } from "mongodb";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { up as createConversationProjection } from "../../../migrations/0068_location_conversation_projection.ts";
import {
  drainConversationProjectionPending,
  enqueueConversationProjectionChange,
  getConversationMapClusterGroups,
  getConversationMapGroupItems,
  getMapDensity,
  LOCATION_CONVERSATION_PENDING,
  LOCATION_CONVERSATION_PROJECTION,
  LOCATION_CONVERSATION_STATE,
  rebuildLocationConversationProjection,
} from "./conversation-map.server.ts";
import { mapCellForCoordinate, mapCellKey } from "./map-spatial.ts";

Deno.test(
  "conversation map summary and cursor pages use only the durable projection",
  withFixtures(["Mongo"], async ({ db }) => {
    await createConversationProjection(db);
    await createConversationProjection(db);
    const generation = "test-generation";
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-02T00:00:00Z");
    const coordinate: [number, number] = [7.4474, 46.948];
    const cells = Object.fromEntries([4, 7, 10, 13, 16, 19].map((zoom) => [
      `cellZ${zoom}`,
      mapCellKey(
        mapCellForCoordinate(
          coordinate[1],
          coordinate[0],
          zoom as 4 | 7 | 10 | 13 | 16 | 19,
        ),
      ),
    ]));
    await db.collection(LOCATION_CONVERSATION_PROJECTION).insertMany(
      Array.from({ length: 125 }, (_, index) => {
        const conversationId = new ObjectId();
        return {
          _id: `${generation}:${conversationId}`,
          generation,
          conversationId,
          name: `Conversation ${index}`,
          start,
          end,
          anchorAt: new Date(start.getTime() + index * 1000),
          matched: true,
          matchKind: "stay",
          groupKey: `segment:${index % 25}`,
          loc: { type: "Point", coordinates: coordinate },
          ...cells,
          projectedAt: new Date(),
        };
      }),
    );
    await db.collection(LOCATION_CONVERSATION_STATE).updateOne(
      { _id: "current" },
      {
        $set: {
          ready: true,
          activeGeneration: generation,
          revision: 7,
          status: "ready",
        },
      },
      { upsert: true },
    );

    const summary = await getMapDensity(db, {
      start,
      end,
      bounds: { west: 7, east: 8, south: 46, north: 47.5 },
      zoom: 16,
      layers: ["conversations"],
    });
    expect(summary.totals.matchedConversations).toBe(125);
    expect(summary.conversationClusters[0].conversationCount).toBe(125);

    const firstGroups = await getConversationMapClusterGroups(db, {
      start,
      end,
      cell: mapCellForCoordinate(coordinate[1], coordinate[0], 19),
      revision: 7,
      limit: 20,
    });
    expect("items" in firstGroups && firstGroups.items).toHaveLength(20);
    const secondGroups = await getConversationMapClusterGroups(db, {
      start,
      end,
      cell: mapCellForCoordinate(coordinate[1], coordinate[0], 19),
      revision: 7,
      cursor: "nextCursor" in firstGroups
        ? firstGroups.nextCursor ?? undefined
        : undefined,
      limit: 20,
    });
    if (!("items" in firstGroups) || !("items" in secondGroups)) {
      throw new Error("projection unavailable");
    }
    expect(
      new Set([
        ...firstGroups.items.map((row) => row.groupKey),
        ...secondGroups.items.map((row) => row.groupKey),
      ]).size,
    ).toBe(25);

    const firstItems = await getConversationMapGroupItems(db, {
      start,
      end,
      groupKey: "segment:0",
      revision: 7,
      limit: 3,
    });
    if (!("items" in firstItems)) throw new Error("projection unavailable");
    const secondItems = await getConversationMapGroupItems(db, {
      start,
      end,
      groupKey: "segment:0",
      revision: 7,
      cursor: firstItems.nextCursor ?? undefined,
      limit: 3,
    });
    if (!("items" in secondItems)) throw new Error("projection unavailable");
    expect(
      new Set([
        ...firstItems.items.map((row) => String(row.conversationId)),
        ...secondItems.items.map((row) => String(row.conversationId)),
      ]).size,
    ).toBe(5);

    await db.collection("objects").insertOne({
      _id: new ObjectId(),
      isConversation: true,
      name: "Changed while rebuilding",
      timeRanges: [{ start, end }],
    });
    await db.collection(LOCATION_CONVERSATION_PENDING).insertOne({
      _id: "object:future",
      kind: "object",
      documentId: new ObjectId(),
      queuedAt: new Date(Date.now() + 60_000),
    });
    await rebuildLocationConversationProjection(db);
    expect(
      await db.collection(LOCATION_CONVERSATION_PENDING).countDocuments({}),
    ).toBe(1);
    expect(
      await db.collection(LOCATION_CONVERSATION_STATE).findOne({
        _id: "current",
      }),
    ).toMatchObject({ ready: true, stale: true, status: "stale" });
  }),
);

Deno.test(
  "incremental conversation projection keeps nearest-point ordering and segment boundaries",
  withFixtures(["Mongo"], async ({ db }) => {
    await createConversationProjection(db);
    const start = new Date("2026-01-01T00:00:00Z");
    const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
    const point = (seconds: number, longitude: number, visible = true) => ({
      ts: at(seconds),
      visible,
      selection: "accepted",
      loc: { type: "Point", coordinates: [longitude, 1] },
    });
    await db.collection("location_segments").insertMany([
      { type: "move", start, end: at(10) },
      { type: "move", start: at(20), end: at(30) },
    ]);
    await db.collection("location_points").insertMany([
      point(3, 1),
      point(3, 2),
      point(5, 3, false),
      point(7, 4),
      point(31, 5),
    ]);
    const conversations = db.collection("objects");
    const first = await conversations.insertOne({
      isConversation: true,
      timeRanges: [{ start: at(5), end: at(5) }],
    });
    const second = await conversations.insertOne({
      isConversation: true,
      timeRanges: [{ start: at(29), end: at(29) }],
    });
    const { generation } = await rebuildLocationConversationProjection(db);

    const rows = db.collection(LOCATION_CONVERSATION_PROJECTION);
    const firstKey = { _id: `${generation}:${first.insertedId}` } as never;
    const secondKey = { _id: `${generation}:${second.insertedId}` } as never;
    expect((await rows.findOne(firstKey))?.loc.coordinates).toEqual([2, 1]);
    expect((await rows.findOne(secondKey))?.matched).toBe(false);
    for (const { insertedId } of [first, second]) {
      await enqueueConversationProjectionChange(db, {
        kind: "object",
        documentId: insertedId,
      });
    }
    await rows.deleteMany({ generation });

    expect(await drainConversationProjectionPending(db)).toMatchObject({
      processed: 2,
      rebuilt: false,
    });
    expect((await rows.findOne(firstKey))?.loc.coordinates).toEqual([2, 1]);
    expect((await rows.findOne(secondKey))?.matched).toBe(false);
  }),
);
