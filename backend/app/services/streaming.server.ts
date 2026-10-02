import { ObjectId } from "bson";
import { ObjectId as MongoObjectId } from "mongodb";
import { getServerAuth } from "@/lib/auth/core.server.ts";
import { teeOutput } from "@/lib/subprocess.ts";

export interface AudioChunk {
  _id?: ObjectId;
  format: string;
  original_id?: ObjectId;
  index: number;
  ingested_at: Date;
  start: Date;
  data: Uint8Array;
}

export interface SourceFile {
  _id: ObjectId;
  start: Date;
  size?: number;
  extension: string;
  ingested: boolean;
  importer: string;
  platform: {
    system: string;
    node: string;
  };
  metadata: Record<string, any>;
  processing_status: string;
  storage_key?: string;
  created_by: string;
}

export async function createSourceFile(
  startTime: Date,
  fileSize: number | undefined,
  filename: string,
  metadata: Record<string, any>,
  createdBy: string,
): Promise<MongoObjectId> {
  const auth = await getServerAuth();
  const mongoResource = auth.getResource("mongo");

  const extension = filename.split(".").pop() || "unknown";

  const sourceFile: Omit<SourceFile, "_id"> = {
    start: startTime,
    size: fileSize,
    extension,
    ingested: false,
    importer: "streaming_api",
    platform: {
      system: "api",
      node: "web",
    },
    metadata,
    processing_status: "streaming",
    created_by: createdBy,
  };

  const result = await mongoResource({
    action: "insertOne",
    collection: "source_files",
    doc: sourceFile,
  }) as { insertedId: MongoObjectId };

  console.log(
    `Source file created: ${result.insertedId}, start: ${startTime.toISOString()}, size: ${fileSize} bytes`,
  );
  return result.insertedId;
}

export async function getSourceFile(
  sourceFileId: ObjectId,
): Promise<SourceFile | null> {
  const auth = await getServerAuth();
  const mongoResource = auth.getResource("mongo");

  return await mongoResource({
    action: "findOne",
    collection: "source_files",
    query: { _id: sourceFileId },
  }) as SourceFile | null;
}

export async function processAudioFile(
  audioFile: File,
  expectedDurationMs?: number,
): Promise<{ audioData: Uint8Array; actualDurationMs: number }> {
  console.log(
    `Processing audio file: ${audioFile.name}, size: ${audioFile.size} bytes`,
  );

  const tempInputPath = await Deno.makeTempFile({
    suffix: `.${audioFile.name.split(".").pop()}`,
  });
  const tempOutputPath = await Deno.makeTempFile({ suffix: ".opus" });

  try {
    const inputData = new Uint8Array(await audioFile.arrayBuffer());
    await Deno.writeFile(tempInputPath, inputData);

    const ffmpegArgs = [
      "-i",
      tempInputPath,
      "-acodec",
      "libopus",
      "-b:a",
      "64k",
      "-map_metadata",
      "-1",
      "-y",
      tempOutputPath,
    ];

    console.log(`Running FFmpeg: ffmpeg ${ffmpegArgs.join(" ")}`);

    const process = new Deno.Command("ffmpeg", {
      args: ffmpegArgs,
      stdout: "piped",
      stderr: "piped",
    });

    const { success, stderr } = await teeOutput(process, (stream, line) => {
      console.log(`[ffmpeg:${stream}] ${line}`);
    });

    if (!success) {
      const errorOutput = new TextDecoder().decode(stderr);
      throw new Error(`FFmpeg conversion failed: ${errorOutput}`);
    }

    const audioData = await Deno.readFile(tempOutputPath);

    const durationArgs = [
      "-v",
      "quiet",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      tempOutputPath,
    ];

    const durationProcess = new Deno.Command("ffprobe", {
      args: durationArgs,
      stdout: "piped",
      stderr: "piped",
    });

    const { success: durationSuccess, stdout } = await teeOutput(durationProcess);

    let actualDurationMs = 0;
    if (durationSuccess) {
      const durationStr = new TextDecoder().decode(stdout).trim();
      actualDurationMs = Math.round(parseFloat(durationStr) * 1000);
    }

    console.log(
      `Audio processed: ${audioData.length} bytes, duration: ${actualDurationMs}ms`,
    );

    if (expectedDurationMs !== undefined) {
      const toleranceMs = 10;
      if (Math.abs(actualDurationMs - expectedDurationMs) > toleranceMs) {
        console.warn(
          `Duration mismatch: expected ${expectedDurationMs}ms, got ${actualDurationMs}ms`,
        );
      }
    }

    return {
      audioData,
      actualDurationMs,
    };
  } finally {
    try {
      await Promise.all([
        Deno.remove(tempInputPath),
        Deno.remove(tempOutputPath),
      ]);
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function ffmpeg(
  inputData: Uint8Array,
  { inputOptions = [], outputOptions }: {
    inputOptions?: string[];
    outputOptions: string[];
  },
): Promise<Uint8Array> {
  const tempInputPath = await Deno.makeTempFile({ suffix: ".bin" });
  const tempOutputPath = await Deno.makeTempFile({ suffix: ".opus" });
  const finalArgs = [
    ...inputOptions,
    "-i",
    tempInputPath,
    ...outputOptions,
    "-map_metadata",
    "-1",
    "-y",
    tempOutputPath,
  ];
  try {
    await Deno.writeFile(tempInputPath, inputData);
    console.log(`Running FFmpeg: ffmpeg ${finalArgs.join(" ")}`);
    const process = new Deno.Command("ffmpeg", {
      args: finalArgs,
      stdout: "piped",
      stderr: "piped",
    });

    const { success, stderr } = await teeOutput(process, (stream, line) => {
      console.log(`[ffmpeg:${stream}] ${line}`);
    });

    if (!success) {
      const errorOutput = new TextDecoder().decode(stderr);
      throw new Error(`FFmpeg conversion failed: ${errorOutput}`);
    }

    return Deno.readFile(tempOutputPath);
  } finally {
    try {
      await Promise.all([
        Deno.remove(tempInputPath),
        Deno.remove(tempOutputPath),
      ]);
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function pcmToOpus(audioData: Uint8Array, sampleRate: number = 16000, channels: number = 1): Promise<Uint8Array> {
  return await ffmpeg(
    audioData,
    {
      inputOptions: ["-f", "s16le", "-ar", String(sampleRate), "-ac", String(channels)],
      outputOptions: ["-c:a", "libopus", "-b:a", "64k"],
    },
  );
}

async function float32ToOpus(audioData: Uint8Array, sampleRate: number = 16000, channels: number = 1): Promise<Uint8Array> {
  return await ffmpeg(
    audioData,
    {
      inputOptions: ["-f", "f32le", "-ar", String(sampleRate), "-ac", String(channels)],
      outputOptions: ["-c:a", "libopus", "-b:a", "64k"],
    },
  );
}

export interface AudioFormatConfig {
  format: "opus" | "pcm" | "float32";
  sampleRate?: number;
  channels?: number;
}

export async function createAudioChunk(
  audioData: Uint8Array,
  startTime: Date,
  index: number,
  originalId: ObjectId,
  formatOrConfig: "opus" | "pcm" | "float32" | AudioFormatConfig = "opus",
): Promise<ObjectId> {
  const config: AudioFormatConfig = typeof formatOrConfig === "string"
    ? { format: formatOrConfig }
    : formatOrConfig;
  const { format, sampleRate = 16000, channels = 1 } = config;

  if (format == "pcm") {
    audioData = await pcmToOpus(audioData, sampleRate, channels);
  } else if (format == "float32") {
    audioData = await float32ToOpus(audioData, sampleRate, channels);
  }

  const auth = await getServerAuth();
  const mongoResource = auth.getResource("mongo");

  const chunk: AudioChunk = {
    format: "opus",
    original_id: originalId,
    index,
    ingested_at: new Date(),
    start: startTime,
    data: audioData,
  };

  const result = await mongoResource({
    action: "insertOne",
    collection: "audio_chunks",
    doc: chunk,
  }) as { insertedId: MongoObjectId };

  console.log(
    `Audio chunk created: ${result.insertedId}, index: ${index}, start: ${startTime.toISOString()}, size: ${audioData.length} bytes${
      originalId ? `, original_id: ${originalId}` : ""
    }`,
  );

  return result.insertedId;
}

export async function getSessionChunks(
  sessionId: string,
): Promise<AudioChunk[]> {
  const auth = await getServerAuth();
  const mongoResource = auth.getResource("mongo");

  return await mongoResource({
    action: "find",
    collection: "audio_chunks",
    query: { session_id: sessionId },
    options: { sort: { index: 1 } },
  }) as AudioChunk[];
}

export async function insertTranscriptionWithInvalidation(
  transcriptionData: any,
  startTime: Date,
  endTime?: Date,
): Promise<ObjectId> {
  const auth = await getServerAuth();
  const mongoResource = auth.getResource("mongo");

  const result = await mongoResource({
    action: "insertOne",
    collection: "transcriptions",
    doc: transcriptionData,
  }) as { insertedId: ObjectId };

  console.log(
    `Transcription created: ${result.insertedId}, start: ${startTime.toISOString()}`,
  );

  return result.insertedId;
}
