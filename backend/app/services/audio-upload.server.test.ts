import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.15";
import { Readable } from "node:stream";
import type { Request } from "express";
import {
  AudioUploadLimitError,
  audioUploadTimeoutMs,
  boundedAudioStorage,
  processAudioPath,
} from "./audio-upload.server.ts";

Deno.test("upload disk storage shares quota across files and removes partial overflow", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const storage = boundedAudioStorage(directory, 6);
    const store = (bytes: number[]) =>
      new Promise<{ path: string; size: number }>((resolve, reject) => {
        storage._handleFile({} as Request, {
          stream: Readable.from([new Uint8Array(bytes)]),
        }, (error, info) => {
          if (error) reject(error);
          else resolve(info!);
        });
      });
    const first = await store([1, 2, 3, 4]);
    assertEquals(first.size, 4);
    assertEquals([...await Deno.readFile(first.path)], [1, 2, 3, 4]);
    await assertRejects(() => store([5, 6, 7]), AudioUploadLimitError);
    const remaining = [];
    for await (const entry of Deno.readDir(directory)) {
      remaining.push(entry.name);
    }
    assertEquals(remaining.length, 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("audio upload splits synthetic audio into bounded ten-second chunks", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const input = `${directory}/fixture.wav`;
    const generated = await new Deno.Command("ffmpeg", {
      args: [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=16000",
        "-t",
        "20.5",
        input,
      ],
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(generated.success, true);
    const chunks: { size: number; offset: number; index: number }[] = [];
    const result = await processAudioPath(
      input,
      async (bytes, index, offsetMs) => {
        chunks.push({ size: bytes.length, offset: offsetMs, index });
      },
    );
    assertEquals(result.chunks, 3);
    assertEquals(result.durationMs, 20500);
    assertEquals(chunks.map((chunk) => [chunk.index, chunk.offset]), [[0, 0], [
      1,
      10000,
    ], [2, 20000]]);
    assertEquals(
      chunks.every((chunk) => chunk.size > 0 && chunk.size < 2 * 1024 * 1024),
      true,
    );
    await assertRejects(() =>
      processAudioPath(input, async () => {}, { signal: AbortSignal.abort() })
    );
    await Deno.writeTextFile(
      `${directory}/invalid.wav`,
      "fixture invalid audio",
    );
    await assertRejects(
      () => processAudioPath(`${directory}/invalid.wav`, async () => {}),
      Error,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("audio processing timeout has a configurable bounded range", () => {
  assertEquals(audioUploadTimeoutMs("600"), 600000);
  for (const value of ["0", "-1", "NaN", "7201"]) {
    let rejected = false;
    try {
      audioUploadTimeoutMs(value);
    } catch {
      rejected = true;
    }
    assertEquals(rejected, true);
  }
});
