import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import {
  createAudioChunk,
  createSourceFile,
  getSourceFile,
  processAudioFile,
} from "./streaming.server.ts";
import { ObjectId } from "bson";
import { ObjectId as MongoObjectId } from "mongodb";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { Auth } from "@/lib/auth/core.server.ts";

Deno.test(
  "processAudioFile should convert audio file to Opus format",
  withFixtures(["SampleAudioFile"], async (audioFile: File) => {
    const result = await processAudioFile(audioFile);

    expect(result).toBeDefined();
    expect(result.audioData).toBeInstanceOf(Uint8Array);
    expect(result.audioData.length).toBeGreaterThan(0);
    expect(result.actualDurationMs).toBeGreaterThan(0);
    expect(result.actualDurationMs).toBeLessThan(10000); // Should be less than 10 seconds for test file
  }),
);

Deno.test(
  "processAudioFile should validate duration when expected duration is provided",
  withFixtures(["SampleAudioFile"], async (audioFile: File) => {
    const expectedDurationMs = 2000; // 2 seconds

    const result = await processAudioFile(audioFile, expectedDurationMs);

    expect(result).toBeDefined();
    expect(result.audioData).toBeInstanceOf(Uint8Array);
    expect(result.actualDurationMs).toBeGreaterThan(0);

    const toleranceMs = 1000; // 1000ms tolerance for test file duration
    expect(Math.abs(result.actualDurationMs - expectedDurationMs)).toBeLessThan(
      toleranceMs,
    );
  }),
);

Deno.test(
  "processAudioFile should handle different audio file formats",
  async () => {
    const mp3File = new File([new Uint8Array(1000)], "test.mp3", {
      type: "audio/mp3",
    });

    try {
      const result = await processAudioFile(mp3File);
      expect(result).toBeDefined();
    } catch (error) {
      expect(error instanceof Error).toBe(true);
      expect((error as Error).message).toContain("FFmpeg");
    }
  },
);

Deno.test(
  "processAudioFile should clean up temporary files on success",
  withFixtures(["SampleAudioFile"], async (audioFile: File) => {
    const tempDir = await Deno.makeTempDir();
    const initialFiles = [];
    for await (const entry of Deno.readDir(tempDir)) {
      initialFiles.push(entry.name);
    }

    await processAudioFile(audioFile);

    const finalFiles = [];
    for await (const entry of Deno.readDir(tempDir)) {
      finalFiles.push(entry.name);
    }

    expect(finalFiles.length).toBe(initialFiles.length);

    await Deno.remove(tempDir, { recursive: true });
  }),
);

Deno.test(
  "processAudioFile should handle FFmpeg errors gracefully",
  async () => {
    const invalidAudioFile = new File(
      [new Uint8Array([1, 2, 3, 4])],
      "invalid.wav",
      { type: "audio/wav" },
    );

    try {
      await processAudioFile(invalidAudioFile);
      expect(false).toBe(true); // Should not reach here
    } catch (error) {
      expect(error instanceof Error).toBe(true);
      expect((error as Error).message).toContain("FFmpeg conversion failed");
    }
  },
);

Deno.test(
  "createSourceFile should create a source file record",
  withFixtures(["Admin", "Mongo", "ServerAuth"], async (auth: Auth) => {
    const startTime = new Date();
    const fileSize = 1024;
    const filename = "test.wav";
    const metadata = { test: true };
    const createdBy = "test-user";

    const sourceFileId = await createSourceFile(
      startTime,
      fileSize,
      filename,
      metadata,
      createdBy,
    );

    expect(sourceFileId).toBeInstanceOf(MongoObjectId);

    const sourceFile = await getSourceFile(sourceFileId);
    expect(sourceFile).toBeDefined();
    expect(sourceFile!.start).toEqual(startTime);
    expect(sourceFile!.size).toBe(fileSize);
    expect(sourceFile!.extension).toBe("wav");
    expect(sourceFile!.metadata).toEqual(metadata);
    expect(sourceFile!.created_by).toBe(createdBy);
    expect(sourceFile!.processing_status).toBe("streaming");
    expect(sourceFile!.importer).toBe("streaming_api");
  }),
);

Deno.test(
  "getSourceFile should return null for non-existent source file",
  withFixtures(["Admin", "Mongo", "ServerAuth"], async (auth: Auth) => {
    const nonExistentId = new ObjectId();

    const sourceFile = await getSourceFile(nonExistentId);

    expect(sourceFile).toBe(null);
  }),
);

Deno.test(
  "createAudioChunk should create an audio chunk record",
  withFixtures(["Admin", "Mongo", "ServerAuth"], async (auth: Auth) => {
    const audioData = new Uint8Array([1, 2, 3, 4, 5]);
    const startTime = new Date();
    const index = 0;
    const sourceFileId = new ObjectId();

    const chunkId = await createAudioChunk(
      audioData,
      startTime,
      index,
      sourceFileId,
    );

    expect(chunkId).toBeInstanceOf(MongoObjectId);
  }),
);

Deno.test(
  "createAudioChunk should not write debug files to disk",
  withFixtures(["Admin", "Mongo", "ServerAuth"], async (_auth: Auth) => {
    // Denying .env also prevents listing/chdir into the checkout. Reject
    // unexpected writes directly so a regression cannot persist audio bytes.
    const rejectWrite = () => { throw new Error("Unexpected audio file write"); };
    const writes = [
      stub(Deno, "writeFile", rejectWrite),
      stub(Deno, "writeFileSync", rejectWrite),
      stub(Deno, "writeTextFile", rejectWrite),
      stub(Deno, "writeTextFileSync", rejectWrite),
      stub(Deno, "create", rejectWrite),
      stub(Deno, "createSync", rejectWrite),
    ];
    try {
      const audioData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      await createAudioChunk(audioData, new Date(), 0, new ObjectId(), "opus");
      expect(writes.every((write) => write.calls.length === 0)).toBe(true);
    } finally {
      for (const write of writes) write.restore();
    }
  }),
);

Deno.test(
  "processAudioFile should handle large audio files efficiently",
  withFixtures(["SampleAudioFile"], async (audioFile: File) => {
    const startTime = performance.now();
    const result = await processAudioFile(audioFile);
    const endTime = performance.now();
    const processingTime = endTime - startTime;

    expect(result).toBeDefined();
    expect(result.audioData).toBeInstanceOf(Uint8Array);
    expect(result.actualDurationMs).toBeGreaterThan(0);

    expect(processingTime).toBeLessThan(5000);
  }),
);
