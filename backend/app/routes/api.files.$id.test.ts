import { expect } from "@std/expect";
import { ObjectId } from "mongodb";
import { Readable } from "node:stream";
import { withFixtures } from "@/tests/fixtures.server.ts";
import {
  gridFsFileEtag,
  isExpectedFileStreamAbort,
  mediaFileBelongsToPrincipal,
  prepareGridFsDownload,
} from "./api.files.$id.ts";

Deno.test("expected client stream aborts are not treated as file errors", () => {
  expect(
    isExpectedFileStreamAbort(
      Object.assign(new Error("closed"), {
        code: "ERR_STREAM_PREMATURE_CLOSE",
      }),
      false,
    ),
  ).toBe(true);
  expect(isExpectedFileStreamAbort(new Error("reset"), true)).toBe(
    true,
  );
  expect(isExpectedFileStreamAbort(new Error("gridfs failed"), false))
    .toBe(false);
});

Deno.test("fresh GridFS request returns 304 state before opening a download", async () => {
  const id = new ObjectId();
  const file = {
    _id: id,
    length: 123,
    chunkSize: 255 * 1024,
    filename: "preview.webp",
    uploadDate: new Date("2026-09-01T08:00:00.000Z"),
    metadata: { extension: "webp" },
  };
  const etag = gridFsFileEtag(file);
  const actions: unknown[] = [];

  const prepared = await prepareGridFsDownload(
    async (input) => {
      actions.push(input.action);
      if (input.action === "find") return [file];
      throw new Error(
        "download must not be opened for a fresh cache validator",
      );
    },
    "media_previews",
    id,
    etag,
  );

  expect(prepared).toMatchObject({
    status: "not-modified",
    contentType: "image/webp",
    etag,
  });
  expect(actions).toEqual(["find"]);
});

Deno.test("GridFS response preparation returns a lazy readable stream", async () => {
  const id = new ObjectId();
  const file = {
    _id: id,
    length: 3,
    chunkSize: 255 * 1024,
    filename: "sample.bin",
    uploadDate: new Date("2026-09-01T08:00:00.000Z"),
  };
  let reads = 0;
  const stream = new Readable({
    read() {
      reads += 1;
      this.push(new Uint8Array([1, 2, 3]));
      this.push(null);
    },
  });
  const actions: unknown[] = [];

  const prepared = await prepareGridFsDownload(
    async (input) => {
      actions.push(input.action);
      return input.action === "find" ? [file] : stream;
    },
    "uploads",
    id,
  );

  expect(prepared?.status).toBe("ok");
  expect(actions).toEqual(["find", "download"]);
  expect(reads).toBe(0);

  const bytes: number[] = [];
  if (prepared?.status === "ok") {
    for await (const chunk of prepared.stream) bytes.push(...chunk);
  }
  expect(bytes).toEqual([1, 2, 3]);
  expect(reads).toBe(1);
});

Deno.test(
  "media files allow canonical and active staged references owned by the principal",
  withFixtures(["Mongo"], async ({ db }) => {
    const owner = "owner-a";
    const now = new Date("2026-08-21T12:00:00.000Z");
    const canonicalOriginalId = new ObjectId();
    const canonicalPreviewId = new ObjectId();
    const stagedOriginalId = new ObjectId();
    const stagedPreviewId = new ObjectId();

    await db.collection("media_assets").insertOne({
      owner,
      managedOriginal: { fileId: canonicalOriginalId },
      preview: { fileId: canonicalPreviewId },
    });
    await db.collection("media_imports").insertOne({
      owner,
      status: "preview",
      expiresAt: new Date("2026-08-21T13:00:00.000Z"),
      items: [{
        managedOriginal: { fileId: stagedOriginalId },
        thumbnail: { fileId: stagedPreviewId },
      }],
    });

    expect(
      await mediaFileBelongsToPrincipal(
        db,
        "media_originals",
        canonicalOriginalId,
        owner,
        now,
      ),
    ).toBe(true);
    expect(
      await mediaFileBelongsToPrincipal(
        db,
        "media_previews",
        canonicalPreviewId,
        owner,
        now,
      ),
    ).toBe(true);
    expect(
      await mediaFileBelongsToPrincipal(
        db,
        "media_originals",
        stagedOriginalId,
        owner,
        now,
      ),
    ).toBe(true);
    expect(
      await mediaFileBelongsToPrincipal(
        db,
        "media_previews",
        stagedPreviewId,
        owner,
        now,
      ),
    ).toBe(true);
  }),
);

Deno.test(
  "media files deny cross-owner, expired staging, and wrong-bucket references",
  withFixtures(["Mongo"], async ({ db }) => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    const foreignOriginalId = new ObjectId();
    const foreignPreviewId = new ObjectId();
    const expiredStagedId = new ObjectId();
    const previewOnlyId = new ObjectId();

    await db.collection("media_assets").insertOne({
      owner: "owner-b",
      managedOriginal: { fileId: foreignOriginalId },
      thumbnail: { fileId: foreignPreviewId },
    });
    await db.collection("media_imports").insertOne({
      owner: "owner-a",
      status: "preview",
      expiresAt: new Date("2026-08-21T11:00:00.000Z"),
      items: [{ managedOriginal: { fileId: expiredStagedId } }],
    });
    await db.collection("media_assets").insertOne({
      owner: "owner-a",
      thumbnail: { fileId: previewOnlyId },
    });

    expect(
      await mediaFileBelongsToPrincipal(
        db,
        "media_originals",
        foreignOriginalId,
        "owner-a",
        now,
      ),
    ).toBe(false);
    expect(
      await mediaFileBelongsToPrincipal(
        db,
        "media_previews",
        foreignPreviewId,
        "owner-a",
        now,
      ),
    ).toBe(false);
    expect(
      await mediaFileBelongsToPrincipal(
        db,
        "media_originals",
        expiredStagedId,
        "owner-a",
        now,
      ),
    ).toBe(false);
    expect(
      await mediaFileBelongsToPrincipal(
        db,
        "media_originals",
        previewOnlyId,
        "owner-a",
        now,
      ),
    ).toBe(false);
  }),
);
