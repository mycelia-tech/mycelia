import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request } from "express";
import { join } from "@std/path";

export const MAX_AUDIO_UPLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_AUDIO_UPLOAD_FILES = 20;
// Match the host ingestion chunk contract (python/chunking.py).
export const AUDIO_CHUNK_SECONDS = 10;
export const MAX_AUDIO_DURATION_SECONDS = 24 * 60 * 60;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const INPUT_FORMATS =
  "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,wav,aac,mp3,ogg,flac,caf,aiff";

export class AudioUploadLimitError extends Error {}

/** Each stream writes directly to a private request directory; quota is shared. */
export function boundedAudioStorage(
  directory: string,
  maxBytes = MAX_AUDIO_UPLOAD_BYTES,
) {
  let totalBytes = 0;
  return {
    _handleFile(
      _req: Request,
      file: { stream: Readable },
      callback: (
        error: Error | null,
        info?: { path: string; size: number; filename?: string },
      ) => void,
    ) {
      const path = join(directory, crypto.randomUUID());
      let size = 0;
      const quota = new Transform({
        transform(chunk, _encoding, next) {
          size += chunk.length;
          totalBytes += chunk.length;
          next(
            totalBytes > maxBytes
              ? new AudioUploadLimitError(
                "Audio files exceed the 500 MiB request limit",
              )
              : null,
            chunk,
          );
        },
      });
      pipeline(
        file.stream,
        quota,
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      )
        .then(() =>
          callback(null, { path, size, filename: path.split("/").pop() })
        )
        .catch(async (error) => {
          await unlink(path).catch(() => {});
          callback(error);
        });
    },
    _removeFile(
      _req: Request,
      file: { path: string },
      callback: (error: Error | null) => void,
    ) {
      unlink(file.path).then(() => callback(null)).catch((error) =>
        callback(error)
      );
    },
  };
}

export function audioUploadTimeoutMs(
  raw = Deno.env.get("AUDIO_UPLOAD_PROCESS_TIMEOUT_SECONDS"),
): number {
  const seconds = Number(raw ?? 600);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 7200) {
    throw new Error(
      "AUDIO_UPLOAD_PROCESS_TIMEOUT_SECONDS must be an integer from 1 to 7200",
    );
  }
  return seconds * 1000;
}

async function runAudioCommand(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const child = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
    signal,
  }).spawn();
  async function read(stream: ReadableStream<Uint8Array>) {
    let result = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      // Drain diagnostics without retaining unbounded FFmpeg output.
      if (result.length < 8192) {
        result += decoder.decode(chunk.subarray(0, 8192 - result.length));
      }
    }
    return result;
  }
  const [status, stdout] = await Promise.all([
    child.status,
    read(child.stdout),
    read(child.stderr),
  ]);
  signal.throwIfAborted();
  if (!status.success) {
    throw new Error(`${command} could not process this audio file`);
  }
  return stdout;
}

/** Encode on disk, then read one bounded chunk at a time. No full-file buffer. */
export async function processAudioPath(
  inputPath: string,
  writeChunk: (
    audio: Uint8Array,
    index: number,
    offsetMs: number,
  ) => Promise<void>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ chunks: number; durationMs: number }> {
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(options.timeoutMs ?? audioUploadTimeoutMs()),
  ]);
  const inputOptions = [
    "-v",
    "error",
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    INPUT_FORMATS,
  ];
  const duration = Number((await runAudioCommand("ffprobe", [
    ...inputOptions,
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    inputPath,
  ], signal)).trim());
  if (
    !Number.isFinite(duration) || duration <= 0 ||
    duration > MAX_AUDIO_DURATION_SECONDS
  ) {
    throw new AudioUploadLimitError(
      "Audio must have a known duration between zero and 24 hours",
    );
  }
  const directory = await Deno.makeTempDir({ prefix: "mycelia-audio-chunks-" });
  try {
    await runAudioCommand("ffmpeg", [
      ...inputOptions,
      "-nostdin",
      "-i",
      inputPath,
      "-map",
      "0:a:0",
      "-vn",
      // Bound encoded output even if a container reports a false duration.
      // The chunk-count check below rejects this boundary, never accepts truncation.
      "-t",
      String(MAX_AUDIO_DURATION_SECONDS + AUDIO_CHUNK_SECONDS),
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      "-map_metadata",
      "-1",
      "-f",
      "segment",
      "-segment_time",
      String(AUDIO_CHUNK_SECONDS),
      "-reset_timestamps",
      "1",
      join(directory, "%010d.opus"),
    ], signal);
    const paths: string[] = [];
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isFile && /^\d{10}\.opus$/.test(entry.name)) {
        paths.push(join(directory, entry.name));
      }
    }
    if (
      paths.length === 0 ||
      paths.length >
        Math.ceil(MAX_AUDIO_DURATION_SECONDS / AUDIO_CHUNK_SECONDS)
    ) {
      throw new AudioUploadLimitError(
        "Audio produced an invalid number of chunks",
      );
    }
    paths.sort();
    for (const [index, path] of paths.entries()) {
      signal.throwIfAborted();
      const { size } = await Deno.stat(path);
      if (size === 0 || size > MAX_CHUNK_BYTES) {
        throw new AudioUploadLimitError(
          "Encoded audio chunk exceeds its size limit",
        );
      }
      await writeChunk(
        await Deno.readFile(path),
        index,
        index * AUDIO_CHUNK_SECONDS * 1000,
      );
      await Deno.remove(path);
    }
    return { chunks: paths.length, durationMs: Math.round(duration * 1000) };
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}
