import { type Auth, authenticate } from "@/lib/auth/core.server.ts";
import { createWebSocketAuthRequest } from "@/lib/auth/websocket.ts";
import { type WyomingHeader } from "@/lib/audio/wyoming.ts";
import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import {
  type AudioFormatConfig,
  createAudioChunk,
  createSourceFile,
} from "@/services/streaming.server.ts";
import { ObjectId } from "mongodb";
import Denque from "denque";
import { defaultResourceManager } from "@/lib/auth/index.ts";
import {
  closeWebSocket,
  sendWebSocket,
  terminateWebSocket,
} from "@/lib/websocket-transport.ts";
import {
  OpusDecoder,
  type OpusDecoderSampleRate,
} from "npm:opus-decoder@^0.7.11";

// Debug logging - enable with DEBUG_AUDIO_WS=true
const DEBUG = Deno.env.get("DEBUG_AUDIO_WS") === "true";
const WS_OPEN = 1;

// Logging helper for consistent format
const log = (level: string, msg: string, data?: Record<string, unknown>) => {
  if (!DEBUG && level === "DEBUG") return;
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[AUDIO-WS-OPUS] ${timestamp} ${level}: ${msg}${dataStr}`);
};

const OPUS_CHANNELS = 1;

function coerceOpusSampleRate(rate: number): OpusDecoderSampleRate {
  switch (rate) {
    case 8000:
    case 12000:
    case 16000:
    case 24000:
    case 48000:
      return rate;
    default:
      log("WARN", "Unsupported Opus sample rate, defaulting to 16000Hz", {
        rate,
      });
      return 16000;
  }
}

// Opus frame duration in milliseconds (standard is 20ms)
const OPUS_FRAME_DURATION_MS = 20;
// How many frames to buffer before flushing (500 frames = 10 seconds)
const FRAMES_PER_CHUNK = 500;

interface OpusFormat {
  rate: number;
  timestamp?: number;
}

class AsyncLock {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        this.locked = true;
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.locked = false;
          if (this.queue.length > 0) {
            const next = this.queue.shift()!;
            next();
          }
        }
      };

      if (this.locked) {
        this.queue.push(execute);
      } else {
        execute();
      }
    });
  }
}

class OpusWebSocketSession {
  sourceFileId: ObjectId | null = null;
  opusFormat: OpusFormat | null = null;
  startedAt: Date | null = null;
  buffer: Denque<Uint8Array> = new Denque();
  chunkIndex = 0;
  private flushLock = new AsyncLock();
  private opusDecodeLock = new AsyncLock();
  private framesReceived = 0;
  private bytesReceived = 0;
  private sessionId: string;
  private opusDecoder: OpusDecoder<OpusDecoderSampleRate> | null = null;

  constructor(
    private auth: Auth,
    private ws: WebSocket | any,
  ) {
    this.sessionId = crypto.randomUUID().replace(/-/g, "").substring(0, 8);
    log("INFO", `Opus session created`, {
      sessionId: this.sessionId,
      principal: auth.principal,
    });
  }

  async handleAudioStart(header: WyomingHeader): Promise<void> {
    if (!header.data) {
      log("WARN", `Audio start received without data`, {
        sessionId: this.sessionId,
      });
      return;
    }

    const opusFormat = header.data as unknown as OpusFormat;
    const sampleRate = coerceOpusSampleRate(opusFormat.rate);
    const startTime = opusFormat.timestamp
      ? new Date(opusFormat.timestamp * 1000)
      : new Date();

    log("INFO", `Opus stream starting`, {
      sessionId: this.sessionId,
      rate: sampleRate,
      timestamp: opusFormat.timestamp,
      startTime: startTime.toISOString(),
    });

    this.opusFormat = opusFormat;
    this.startedAt = startTime;
    this.chunkIndex = 0;
    this.framesReceived = 0;
    this.bytesReceived = 0;
    this.buffer.clear();

    if (this.opusDecoder) {
      this.opusDecoder.free();
      this.opusDecoder = null;
    }

    try {
      const decoder = new OpusDecoder<OpusDecoderSampleRate>({
        sampleRate,
        channels: OPUS_CHANNELS,
        forceStereo: false,
      });
      this.opusDecoder = decoder;
      await decoder.ready;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log("ERROR", "Failed to initialize Opus decoder", {
        sessionId: this.sessionId,
        error: errorMsg,
      });
      throw error;
    }

    const metadata = {
      rate: sampleRate,
      format: "opus",
      codec: "opus",
      source: "websocket_opus",
    };

    const filename = `audio_${
      opusFormat.timestamp || Date.now()
    }_${Date.now()}.opus`;

    try {
      this.sourceFileId = await createSourceFile(
        startTime,
        undefined,
        filename,
        metadata,
        this.auth.principal,
      );
      log("INFO", `SourceFile created`, {
        sessionId: this.sessionId,
        sourceFileId: this.sourceFileId.toString(),
        startTime: startTime.toISOString(),
        format: `Opus ${opusFormat.rate}Hz`,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log("ERROR", `Failed to create SourceFile`, {
        sessionId: this.sessionId,
        error: errorMsg,
      });
      sendWebSocket(
        this.ws,
        JSON.stringify({ type: "error", message: errorMsg }) + "\n",
        `audio-opus:${this.sessionId}`,
      );
    }
  }

  async handleAudioStop(): Promise<void> {
    const durationSeconds = this.startedAt
      ? (Date.now() - this.startedAt.getTime()) / 1000
      : 0;

    log("INFO", `Opus audio stop received`, {
      sessionId: this.sessionId,
      sourceFileId: this.sourceFileId?.toString(),
      framesReceived: this.framesReceived,
      bytesReceived: this.bytesReceived,
      chunksCreated: this.chunkIndex,
      durationSeconds: Math.round(durationSeconds * 10) / 10,
    });

    if (this.sourceFileId) {
      await this.flushAll();
      log("INFO", `Opus session ended`, {
        sessionId: this.sessionId,
        sourceFileId: this.sourceFileId.toString(),
        totalChunks: this.chunkIndex,
        bufferRemaining: this.buffer.length,
      });
    }

    this.freeDecoder();
  }

  freeDecoder(): void {
    if (this.opusDecoder) {
      try {
        this.opusDecoder.free();
      } catch {
        // ignore errors freeing WASM instance
      }
      this.opusDecoder = null;
    }
  }

  async addOpusFrame(opusFrame: Uint8Array): Promise<void> {
    if (!this.sourceFileId) {
      return;
    }

    this.framesReceived++;
    this.bytesReceived += opusFrame.byteLength;

    // Log periodically (every 100 frames) to avoid flooding
    if (this.framesReceived % 100 === 0) {
      log("DEBUG", `Opus frame progress`, {
        sessionId: this.sessionId,
        framesReceived: this.framesReceived,
        bytesReceived: this.bytesReceived,
        bufferSize: this.buffer.length,
        chunksCreated: this.chunkIndex,
      });
    }

    const decoder = this.opusDecoder;
    if (!decoder) {
      log("ERROR", "Received Opus frame before decoder initialization", {
        sessionId: this.sessionId,
        frameBytes: opusFrame.byteLength,
      });
      return;
    }

    await this.opusDecodeLock.acquire(async () => {
      const result = decoder.decodeFrame(opusFrame);

      if (result.errors.length > 0) {
        for (const error of result.errors) {
          log("WARN", "Opus decoder reported an error", {
            sessionId: this.sessionId,
            error: error.message,
          });
        }
      }

      if (result.samplesDecoded === 0 || result.channelData.length === 0) {
        return;
      }

      const pcm = result.channelData[0];
      const int16Pcm = new Int16Array(pcm.length);

      for (let i = 0; i < pcm.length; i++) {
        const sample = Math.max(-1, Math.min(1, pcm[i]));
        int16Pcm[i] = Math.round(sample * 32767);
      }

      this.buffer.push(
        new Uint8Array(
          int16Pcm.buffer,
          int16Pcm.byteOffset,
          int16Pcm.byteLength,
        ),
      );
    });

    await this.checkAndFlushIfNeeded();
  }

  private calculateChunkStartTime(): Date {
    if (!this.startedAt) {
      return new Date();
    }
    // Each chunk is FRAMES_PER_CHUNK frames * OPUS_FRAME_DURATION_MS milliseconds
    const msOffset = this.chunkIndex * FRAMES_PER_CHUNK *
      OPUS_FRAME_DURATION_MS;
    return new Date(this.startedAt.getTime() + msOffset);
  }

  private async checkAndFlushIfNeeded(): Promise<void> {
    if (!this.sourceFileId || !this.opusFormat) {
      return;
    }

    await this.flushLock.acquire(async () => {
      const currentFrameCount = this.buffer.length;
      if (currentFrameCount < FRAMES_PER_CHUNK) {
        return;
      }

      const numberOfChunks = Math.floor(currentFrameCount / FRAMES_PER_CHUNK);

      for (let i = 0; i < numberOfChunks; i++) {
        const remainingFrames = this.buffer.length;
        if (remainingFrames < FRAMES_PER_CHUNK) {
          break;
        }
        await this.performFlush();
      }
    });
  }

  private async flush(flushAll: boolean = false): Promise<void> {
    if (
      !this.sourceFileId || !this.startedAt || !this.opusFormat ||
      !this.buffer.length
    ) {
      return;
    }

    while (this.buffer.length > 0) {
      const hasWholeChunk = this.buffer.length >= FRAMES_PER_CHUNK;

      if (!flushAll && !hasWholeChunk) {
        break;
      }

      const framesToFlush = flushAll ? this.buffer.length : FRAMES_PER_CHUNK;

      if (framesToFlush === 0) {
        break;
      }

      // Concatenate decoded PCM frames into a single chunk.
      let totalBytes = 0;
      const pcmFrames: Uint8Array[] = [];
      for (let i = 0; i < framesToFlush; i++) {
        const frame = this.buffer.shift();
        if (!frame) {
          break;
        }
        pcmFrames.push(frame);
        totalBytes += frame.byteLength;
      }

      // Combine all PCM frames into single buffer
      const chunkData = new Uint8Array(totalBytes);
      let offset = 0;
      for (const frame of pcmFrames) {
        chunkData.set(frame, offset);
        offset += frame.byteLength;
      }

      const chunkStartTime = this.calculateChunkStartTime();

      const formatConfig: AudioFormatConfig = {
        format: "pcm",
        sampleRate: this.opusFormat.rate,
        channels: OPUS_CHANNELS,
      };

      try {
        await createAudioChunk(
          chunkData,
          chunkStartTime,
          this.chunkIndex,
          this.sourceFileId,
          formatConfig,
        );
        log("INFO", `Opus chunk created`, {
          sessionId: this.sessionId,
          chunkIndex: this.chunkIndex,
          chunkBytes: chunkData.length,
          frameCount: pcmFrames.length,
          chunkStart: chunkStartTime.toISOString(),
          isFinal: flushAll,
          sourceFileId: this.sourceFileId?.toString(),
        });
        this.chunkIndex++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log("ERROR", `Failed to create Opus chunk`, {
          sessionId: this.sessionId,
          chunkIndex: this.chunkIndex,
          isFinal: flushAll,
          error: errorMsg,
        });
        throw error;
      }
    }
  }

  private async performFlush(): Promise<void> {
    await this.flush(false);
  }

  async flushAll(): Promise<void> {
    await this.flush(true);
  }
}

class WyomingPayloadHandler {
  private expectingLength = 0;
  private buffer: Uint8Array[] = [];
  private expectedMessageType: string | null = null;

  get isExpectingPayload(): boolean {
    return this.expectingLength > 0;
  }

  get pendingMessageType(): string | null {
    return this.expectedMessageType;
  }

  setExpectedLength(length: number, messageType?: string): void {
    this.expectingLength = length;
    this.buffer = [];
    this.expectedMessageType = messageType || null;
  }

  addChunk(
    data: Uint8Array,
  ): { payload: Uint8Array; messageType: string | null } | null {
    if (this.expectingLength === 0) {
      return null;
    }

    this.buffer.push(data);
    const totalLength = this.buffer.reduce(
      (sum, chunk) => sum + chunk.length,
      0,
    );

    if (totalLength < this.expectingLength) {
      return null;
    }

    const combined = new Uint8Array(this.expectingLength);
    let offset = 0;
    for (const chunk of this.buffer) {
      const copyLength = Math.min(chunk.length, this.expectingLength - offset);
      combined.set(chunk.slice(0, copyLength), offset);
      offset += copyLength;
      if (offset >= this.expectingLength) break;
    }

    const messageType = this.expectedMessageType;
    this.buffer = [];
    this.expectingLength = 0;
    this.expectedMessageType = null;

    return { payload: combined, messageType };
  }
}

function normalizeBinaryData(data: any): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(Buffer.from(data));
}

function parseWyomingHeader(line: string): WyomingHeader | null {
  try {
    return JSON.parse(line) as WyomingHeader;
  } catch {
    log("DEBUG", "Failed to parse Wyoming protocol header", {
      line: line.substring(0, 100),
    });
    return null;
  }
}

function handlePing(ws: WebSocket | any): void {
  sendWebSocket(
    ws,
    JSON.stringify({ type: "pong" }) + "\n",
    "audio-opus:ping",
  );
}

export async function handleOpusWebSocket(
  ws: WebSocket | any,
  upgrade: IncomingMessage,
): Promise<void> {
  const request = createWebSocketAuthRequest(upgrade);
  log("INFO", `Opus WebSocket connection attempt`, {
    path: request ? new URL(request.url).pathname : "invalid",
    remoteAddress: upgrade.socket?.remoteAddress,
  });

  const auth = request ? await authenticate(request) : null;

  if (ws.readyState !== WS_OPEN) {
    log("INFO", `Opus WebSocket closed during authentication`);
    return;
  }

  if (!auth) {
    log("WARN", `Opus WebSocket auth failed`);
    closeWebSocket(
      ws,
      1008,
      "Unauthorized: Token is missing or invalid",
      "audio-opus:auth",
    );
    throw new Error("Unauthorized");
  }

  log("INFO", `Opus WebSocket authenticated`, { principal: auth.principal });

  await defaultResourceManager.ensureAllowed(
    auth,
    { path: "live.audio", actions: ["write"] },
  );

  if (ws.readyState !== WS_OPEN) {
    log("INFO", `Opus WebSocket closed during authorization`);
    return;
  }

  return new Promise((resolve, reject) => {
    const session = new OpusWebSocketSession(auth, ws);
    const payloadHandler = new WyomingPayloadHandler();
    let textBuffer = "";

    const handleBinaryMessage = async (data: any): Promise<void> => {
      const binaryData = normalizeBinaryData(data);

      // Check if this starts with a JSON header (starts with '{')
      if (binaryData.length > 0 && binaryData[0] === 0x7B) {
        const newlineIndex = binaryData.indexOf(0x0A);
        if (newlineIndex !== -1) {
          const headerBytes = binaryData.slice(0, newlineIndex + 1);
          const headerText = new TextDecoder().decode(headerBytes);
          const header = parseWyomingHeader(headerText.trim());

          if (header && header.payload_length !== undefined) {
            const payloadStart = newlineIndex + 1;
            const payloadData = binaryData.slice(payloadStart);

            if (payloadData.length === header.payload_length) {
              if (header.type === "audio-chunk") {
                await session.addOpusFrame(payloadData);
              }
              return;
            }

            payloadHandler.setExpectedLength(
              header.payload_length,
              header.type,
            );
            const payloadResult = payloadHandler.addChunk(payloadData);
            if (payloadResult) {
              const { payload, messageType } = payloadResult;
              if (messageType === "audio-chunk") {
                await session.addOpusFrame(payload);
              }
            }
            return;
          }
        }
      }

      // Check if we're expecting more payload data
      const payloadResult = payloadHandler.addChunk(binaryData);
      if (payloadResult) {
        const { payload, messageType } = payloadResult;
        if (messageType === "audio-chunk") {
          await session.addOpusFrame(payload);
        }
      } else if (!payloadHandler.isExpectingPayload) {
        // Raw Opus frame without Wyoming header
        await session.addOpusFrame(binaryData);
      }
    };

    const handleTextMessage = async (data: any): Promise<void> => {
      const text = typeof data === "string" ? data : data.toString();
      textBuffer += text;

      while (textBuffer.includes("\n")) {
        const lineEnd = textBuffer.indexOf("\n");
        const line = textBuffer.slice(0, lineEnd);
        textBuffer = textBuffer.slice(lineEnd + 1);

        if (!line.trim()) {
          continue;
        }

        const header = parseWyomingHeader(line);
        if (!header) {
          continue;
        }

        if (header.type === "audio-start") {
          await session.handleAudioStart(header);
        } else if (header.type === "audio-stop") {
          await session.handleAudioStop();
        } else if (header.type === "ping") {
          handlePing(ws);
        }

        if (header.payload_length && header.payload_length > 0) {
          payloadHandler.setExpectedLength(header.payload_length, header.type);
        }
      }
    };

    const handleMessage = async (
      data: any,
      isBinary: boolean,
    ): Promise<void> => {
      if (isBinary) {
        await handleBinaryMessage(data);
      } else {
        await handleTextMessage(data);
      }
    };

    let acceptingMessages = true;
    let messageTail: Promise<void> = Promise.resolve();
    let finalizePromise: Promise<void> | null = null;
    let settlementPromise: Promise<void> | null = null;
    let terminalError: Error | null = null;

    const enqueueMessage = (task: () => Promise<void>): void => {
      if (!acceptingMessages) return;

      messageTail = messageTail.then(async () => {
        if (terminalError) return;
        await task();
      }).catch((error) => {
        const messageError = error instanceof Error
          ? error
          : new Error(String(error));
        log("ERROR", `Opus message task failed`, {
          error: messageError.message,
          stack: messageError.stack,
        });
        failSession(messageError);
      });
    };

    const handleNodeMessage = (data: any, isBinary: boolean): void => {
      enqueueMessage(() => handleMessage(data, isBinary));
    };

    const handleDomMessage = (event: MessageEvent): void => {
      enqueueMessage(async () => {
        let data: any = event.data;
        let isBinary = false;

        if (event.data instanceof Blob) {
          data = await event.data.arrayBuffer();
          isBinary = true;
        } else if (event.data instanceof ArrayBuffer) {
          isBinary = true;
        }

        await handleMessage(data, isBinary);
      });
    };

    const handleDomClose = (event: CloseEvent): void => {
      handleClose(event.code, Buffer.from(event.reason || ""));
    };

    const handleDomError = (event: ErrorEvent): void => {
      handleError(
        event.error instanceof Error
          ? event.error
          : new Error(event.message || "WebSocket transport error"),
      );
    };

    const finalize = (): Promise<void> => {
      if (finalizePromise) return finalizePromise;

      acceptingMessages = false;

      if (typeof ws.off === "function") {
        ws.off("message", handleNodeMessage);
        ws.off("error", handleError);
        ws.off("close", handleClose);
      } else if (typeof ws.removeEventListener === "function") {
        ws.removeEventListener("message", handleDomMessage);
        ws.removeEventListener("error", handleDomError);
        ws.removeEventListener("close", handleDomClose);
      }

      finalizePromise = Promise.resolve().then(async () => {
        await messageTail;
        try {
          await session.flushAll();
        } catch (error) {
          log("ERROR", `Error flushing Opus buffer on cleanup`, {
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          session.freeDecoder();
        }
      });

      return finalizePromise;
    };

    const settleAfterFinalize = (): void => {
      if (settlementPromise) return;

      settlementPromise = finalize().then(
        () => terminalError ? reject(terminalError) : resolve(),
        (finalizationError) =>
          reject(
            terminalError
              ? new AggregateError(
                [terminalError, finalizationError],
                "WebSocket failed while finalizing buffered Opus audio",
              )
              : finalizationError,
          ),
      );
    };

    const failSession = (error: Error): void => {
      terminalError ??= error;
      settleAfterFinalize();
      terminateWebSocket(ws, "audio-opus");
    };

    const handleError = (error: Error) => {
      log("ERROR", `Opus WebSocket error`, {
        error: error.message,
        stack: error.stack,
      });
      failSession(error);
    };

    const handleClose = (code: number, reason: Buffer) => {
      const reasonStr = reason ? reason.toString() : "";
      log("INFO", `Opus WebSocket closed`, { code, reason: reasonStr });
      settleAfterFinalize();
    };

    if (typeof ws.on === "function") {
      ws.on("message", handleNodeMessage);
      ws.on("error", handleError);
      ws.on("close", handleClose);
    } else if (typeof ws.addEventListener === "function") {
      ws.addEventListener("message", handleDomMessage);
      ws.addEventListener("error", handleDomError);
      ws.addEventListener("close", handleDomClose);
    } else {
      const error = new Error(
        "WebSocket object does not support 'on' or 'addEventListener' methods",
      );
      terminalError = error;
      settleAfterFinalize();
    }

    if (ws.readyState !== WS_OPEN && !settlementPromise) {
      log("INFO", `Opus WebSocket closed during session setup`);
      settleAfterFinalize();
    }
  });
}
