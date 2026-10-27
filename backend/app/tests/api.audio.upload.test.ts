import { assertEquals } from "jsr:@std/assert@^1.0.15";
import express from "express";
import { ObjectId } from "mongodb";
import { createAudioUploadHandler } from "@/routes/api.audio.upload.ts";

Deno.test("audio upload keeps failed source history and successful response contract", async () => {
  const sourceId = new ObjectId();
  const updates: any[] = [];
  const chunkTimes: number[] = [];
  const inputPaths: string[] = [];
  let fail = true;
  const handler = createAudioUploadHandler({
    authenticateOr401: async () => ({ principal: "fixture" }),
    createSourceFile: async () => sourceId,
    createAudioChunk: async (_audio: Uint8Array, date: Date) => {
      chunkTimes.push(date.getTime());
      return new ObjectId();
    },
    getMongoResource: async () => async (input: any) => {
      updates.push(input);
      return {};
    },
    processAudioPath: async (
      path: string,
      write: (
        audio: Uint8Array,
        index: number,
        offset: number,
      ) => Promise<void>,
    ) => {
      inputPaths.push(path);
      assertEquals([...await Deno.readFile(path)], [1, 2, 3]);
      await write(new Uint8Array([1]), 0, 0);
      if (fail) throw new Error("Synthetic encoder failure");
      await write(new Uint8Array([2]), 1, 10000);
      return { chunks: 2, durationMs: 12500 };
    },
  } as any);
  const app = express();
  app.post("/upload", handler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  try {
    const upload = async () => {
      const form = new FormData();
      form.append(
        "files",
        new Blob([new Uint8Array([1, 2, 3])]),
        "fixture.wav",
      );
      const response = await fetch(`http://127.0.0.1:${address.port}/upload`, {
        method: "POST",
        body: form,
      });
      assertEquals(response.status, 200);
      return response.json();
    };
    const failed = await upload();
    assertEquals(failed.failed, 1);
    assertEquals(failed.results[0].sourceFileId, sourceId.toString());
    assertEquals(failed.results[0].chunks, 1);
    assertEquals(updates[0].update.$set.processing_status, "failed");
    assertEquals(updates[0].update.$set.ingestion.recovery, "reupload");
    fail = false;
    const succeeded = await upload();
    assertEquals(succeeded, {
      success: true,
      processed: 1,
      failed: 0,
      results: [{
        filename: "fixture.wav",
        sourceFileId: sourceId.toString(),
        chunks: 2,
        durationMs: 12500,
      }],
    });
    assertEquals(chunkTimes[2] - chunkTimes[1], 10000);
    assertEquals(updates[1].update.$set.processing_status, "complete");
    for (const path of inputPaths) {
      let exists = true;
      try {
        await Deno.stat(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) exists = false;
        else throw error;
      }
      assertEquals(exists, false);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error?: Error) => error ? reject(error) : resolve())
    );
  }
});
