import { expect, fn } from "@std/expect";
import { Auth } from "@/lib/auth/core.server.ts";
import { getRootDB as getSharedRootDB } from "@/lib/mongo/core.server.ts";
import { FsResource, getFsResource, getRootDB } from "../fs.server.ts";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { ObjectId } from "bson";
import { ObjectId as MongoObjectId } from "mongodb";

Deno.test("FsResource uses the shared MongoDB connection provider", () => {
  const first = new FsResource();
  const second = new FsResource();

  expect(getRootDB).toBe(getSharedRootDB);
  expect(first.getRootDB).toBe(getSharedRootDB);
  expect(second.getRootDB).toBe(first.getRootDB);
});

Deno.test(
  "should upload a file and download it back",
  withFixtures([
    "Admin",
    "Mongo",
  ], async (auth: Auth) => {
    const fs = await getFsResource(auth);
    const upload = await fs({
      action: "upload",
      bucket: "test",
      filename: "file.bin",
      data: new Uint8Array([1, 2, 3]),
      metadata: { foo: "bar" },
    });
    expect(upload).toBeInstanceOf(MongoObjectId);

    const download = await fs({
      action: "download",
      bucket: "test",
      id: upload.toString(),
    });
    expect(download).toEqual(new Uint8Array([1, 2, 3]));
  }),
);

Deno.test(
  "should download a file",
  withFixtures([
    "Admin",
    "uploadedFile",
  ], async (auth: Auth, uploadId: ObjectId) => {
    const fs = await getFsResource(auth);

    const download = await fs({
      action: "download",
      bucket: "test",
      id: uploadId.toString(),
    });
    expect(download).toBeInstanceOf(Uint8Array);
  }),
);

Deno.test(
  "should expose a GridFS download stream without buffering the file",
  withFixtures([
    "Admin",
    "uploadedFile",
  ], async (auth: Auth, uploadId: ObjectId) => {
    const fs = await getFsResource(auth);
    const stream = await fs({
      action: "download",
      bucket: "test",
      id: uploadId.toString(),
      stream: true,
    }) as AsyncIterable<Uint8Array>;

    const bytes: number[] = [];
    for await (const chunk of stream) bytes.push(...chunk);

    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
  }),
);

Deno.test(
  "should find files",
  withFixtures([
    "Admin",
    "uploadedFile",
  ], async (auth: Auth, uploadId: ObjectId) => {
    const fs = await getFsResource(auth);
    const result = await fs({
      action: "find",
      bucket: "test",
      query: {},
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toMatchObject({
      _id: uploadId,
      metadata: { foo: "bar" },
    });
  }),
);
