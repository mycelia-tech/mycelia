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
import { ObjectId } from "bson";
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
  console.log(`[AUDIO-WS] ${timestamp} ${level}: ${msg}${dataStr}`);
};

const CHUNK_DURATION_SECONDS = 10;

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

// ============================================================================
// Audio Format Detection
// ============================================================================

export type DetectedFormat = "opus" | "pcm" | "float32" | "unknown";

/**
 * Check if data is Opus audio in Ogg container.
 * Opus uses Ogg container with "OggS" magic bytes at the start.
 */
export function isOpusOgg(data: Uint8Array): boolean {
  return data.length >= 4 &&
    data[0] === 0x4F && // 'O'
    data[1] === 0x67 && // 'g'
    data[2] === 0x67 && // 'g'
    data[3] === 0x53; // 'S'
}

/**
 * Check if data is 16-bit PCM audio.
 * PCM must be aligned to 2-byte boundaries (16-bit samples).
 */
export function isPcm(data: Uint8Array): boolean {
  if (data.length === 0 || data.length % 2 !== 0) {
    return false;
  }

  // PCM is just raw audio samples, no magic bytes to check
  // Length must be multiple of 2 bytes (16-bit samples)
  return true;
}

/**
 * Check if data is 32-bit float audio.
 * Float32 must be aligned to 4-byte boundaries and values in typical audio range.
 */
export function isFloat32(data: Uint8Array): boolean {
  if (data.length < 4 || data.length % 4 !== 0) {
    return false;
  }

  // Check if values are in typical audio range [-2.0, 2.0]
  // Sample first 10 float32 values (40 bytes)
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const samplesToCheck = Math.min(10, Math.floor(data.length / 4));

    for (let i = 0; i < samplesToCheck * 4; i += 4) {
      const val = view.getFloat32(i, true); // little-endian

      // Float32 audio should be roughly in range [-2.0, 2.0]
      // (typically [-1.0, 1.0] but allow some headroom)
      if (!isFinite(val) || Math.abs(val) > 3.0) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Detect audio format by inspecting binary data.
 * Returns: "opus", "pcm", "float32", or "unknown"
 *
 * Checks formats in order of specificity:
 * 1. Opus (has magic bytes - most specific)
 * 2. Float32 (has alignment + value range constraints)
 * 3. PCM (only has alignment constraint - least specific)
 */
export function detectAudioFormat(data: Uint8Array): DetectedFormat {
  if (data.length === 0) {
    return "unknown";
  }

  // Check in order of specificity
  if (isOpusOgg(data)) return "opus";
  if (isFloat32(data)) return "float32";
  if (isPcm(data)) return "pcm";

  return "unknown";
}

interface AudioFormat {
  rate: number;
  width: number;
  channels: number;
  mode: string;
  timestamp?: number;
}

// Determine the audio format type from sample width in bytes
/**
 * Detect format from Wyoming header audio format.
 * Wyoming headers can declare format via width field:
 * - width=0 → Opus (compressed, variable-length frames)
 * - width=2 → 16-bit PCM (2 bytes per sample)
 * - width=4 → 32-bit float (4 bytes per sample)
 */
function getFormatFromHeader(audioFormat: AudioFormat): DetectedFormat {
  const width = audioFormat.width;

  // width=0 means Opus compressed audio (not PCM)
  if (width === 0) {
    return "opus";
  } // width=2 means 16-bit PCM (2 bytes per sample)
  else if (width === 2) {
    return "pcm";
  } // width=4 means 32-bit float (4 bytes per sample)
  else if (width === 4) {
    return "float32";
  } else {
    log("WARN", `Unknown audio width in header, defaulting to pcm`, {
      width,
      rate: audioFormat.rate,
      channels: audioFormat.channels,
    });
    return "pcm";
  }
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

class PcmWebSocketSession {
  sourceFileId: ObjectId | null = null;
  audioFormat: AudioFormat | null = null;
  startedAt: Date | null = null;
  buffer: Denque<Uint8Array> = new Denque();
  bufferByteLength = 0;
  bytesFlushed = 0;
  chunkIndex = 0;
  bytesPerChunk = 0;
  private flushLock = new AsyncLock();
  private messagesReceived = 0;
  private bytesReceived = 0;
  private sessionId: string;
  private detectedFormat: DetectedFormat | null = null;
  private opusDecodedToPcm = false; // Track if we're converting Opus→PCM (Chronicle mode)
  private opusFrameCount = 0; // Track number of Opus frames received
  private lastFlushTime: Date | null = null; // Track last flush for time-based flushing
  private opusDecoder: OpusDecoder<OpusDecoderSampleRate> | null = null; // opus-decoder WASM instance (in-process, like Chronicle)
  private opusDecodeLock = new AsyncLock(); // Serialize Opus frame decoding (Chronicle pattern)

  constructor(
    private auth: Auth,
    private ws: WebSocket | any,
  ) {
    this.sessionId = crypto.randomUUID().replace(/-/g, "").substring(0, 8);
    log("INFO", `Session created`, {
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

    const audioFormat = header.data as unknown as AudioFormat;
    const startTime = audioFormat.timestamp
      ? new Date(audioFormat.timestamp * 1000)
      : new Date();

    log("INFO", `[AUDIO_WS] [START] Audio stream starting`, {
      sessionId: this.sessionId,
      rate: audioFormat.rate,
      width: audioFormat.width,
      channels: audioFormat.channels,
      mode: audioFormat.mode,
      timestamp: audioFormat.timestamp,
      startTime: startTime.toISOString(),
    });

    this.audioFormat = audioFormat;
    this.startedAt = startTime;
    this.bytesFlushed = 0;
    this.chunkIndex = 0;
    this.messagesReceived = 0;
    this.bytesReceived = 0;
    this.opusFrameCount = 0;
    this.lastFlushTime = startTime;
    this.buffer.clear();
    this.bufferByteLength = 0;

    // Detect format from header
    this.detectedFormat = getFormatFromHeader(audioFormat);

    // For Opus: Create in-process WASM decoder (like Chronicle architecture)
    if (this.detectedFormat === "opus") {
      try {
        log("INFO", `[AUDIO_WS] Creating in-process Opus decoder (WASM)`, {
          sessionId: this.sessionId,
          sampleRate: audioFormat.rate,
          channels: audioFormat.channels,
        });

        const decoder = new OpusDecoder<OpusDecoderSampleRate>({
          sampleRate: coerceOpusSampleRate(audioFormat.rate), // OMI typically sends 16kHz
          channels: audioFormat.channels,
          forceStereo: false,
        });
        this.opusDecoder = decoder;

        await decoder.ready;

        log(
          "INFO",
          `[AUDIO_WS] Opus decoder ready (in-process, zero HTTP overhead)`,
          {
            sessionId: this.sessionId,
          },
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log("ERROR", `[AUDIO_WS] Failed to create Opus decoder`, {
          sessionId: this.sessionId,
          error: errorMsg,
        });
        throw error;
      }
    }

    // Calculate bytes per second and chunk size
    let bytesPerSecond: number;
    if (audioFormat.width === 0) {
      // For Opus: Decode to PCM, so calculate PCM buffer size
      // PCM: 16kHz * 2 bytes * 1 channel * duration
      bytesPerSecond = audioFormat.rate * 2 * audioFormat.channels; // 2 bytes for 16-bit PCM
      this.bytesPerChunk = bytesPerSecond * CHUNK_DURATION_SECONDS; // 320KB for 10 sec
      this.opusFrameCount = 0;
      this.lastFlushTime = startTime;

      log(
        "INFO",
        `[AUDIO_WS] Audio format calculated (Opus→PCM - byte-based)`,
        {
          sessionId: this.sessionId,
          bytesPerChunk: this.bytesPerChunk,
          chunkDurationSeconds: CHUNK_DURATION_SECONDS,
          note: "Opus decoded frame-by-frame to PCM, buffered as PCM",
        },
      );
    } else {
      // PCM or float: rate * width * channels
      bytesPerSecond = audioFormat.rate * audioFormat.width *
        audioFormat.channels;
      this.bytesPerChunk = bytesPerSecond * CHUNK_DURATION_SECONDS;

      log(
        "INFO",
        `[AUDIO_WS] Audio format calculated (PCM/float32 - byte-based)`,
        {
          sessionId: this.sessionId,
          bytesPerSecond,
          bytesPerChunk: this.bytesPerChunk,
          chunkDurationSeconds: CHUNK_DURATION_SECONDS,
        },
      );
    }

    // Detect format from Wyoming header (PCM vs float32 based on width)
    // Note: Opus cannot be detected from header alone - will be detected from actual data
    const declaredFormat = getFormatFromHeader(audioFormat);
    this.detectedFormat = declaredFormat; // Initial format based on header

    log("INFO", `[AUDIO_WS] Audio format from header`, {
      sessionId: this.sessionId,
      width: audioFormat.width,
      rate: audioFormat.rate,
      channels: audioFormat.channels,
      declaredFormat,
    });

    const metadata = {
      rate: audioFormat.rate,
      width: audioFormat.width,
      channels: audioFormat.channels,
      mode: audioFormat.mode,
      format: declaredFormat,
      source: "websocket",
      protocol: "wyoming", // For frontend display
      data: "opus", // For frontend display - always stored as Ogg Opus
    };

    const filename = `audio_${
      audioFormat.timestamp || Date.now()
    }_${Date.now()}.pcm`;

    try {
      this.sourceFileId = await createSourceFile(
        startTime,
        undefined,
        filename,
        metadata,
        this.auth.principal,
      );
      log("INFO", `[AUDIO_WS] SourceFile created`, {
        sessionId: this.sessionId,
        sourceFileId: this.sourceFileId.toString(),
        startTime: startTime.toISOString(),
        format: `${audioFormat.rate}Hz ${
          audioFormat.width * 8
        }bit ${audioFormat.channels}ch`,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log("ERROR", `[AUDIO_WS] Failed to create SourceFile`, {
        sessionId: this.sessionId,
        error: errorMsg,
      });
      sendWebSocket(
        this.ws,
        JSON.stringify({ type: "error", message: errorMsg }) + "\n",
        `audio-pcm:${this.sessionId}`,
      );
    }
  }

  async handleAudioStop(): Promise<void> {
    const durationSeconds = this.startedAt
      ? (Date.now() - this.startedAt.getTime()) / 1000
      : 0;

    log("INFO", `[AUDIO_WS] [STOP] Audio stop received`, {
      sessionId: this.sessionId,
      sourceFileId: this.sourceFileId?.toString(),
      messagesReceived: this.messagesReceived,
      bytesReceived: this.bytesReceived,
      chunksCreated: this.chunkIndex,
      durationSeconds: Math.round(durationSeconds * 10) / 10,
    });

    if (this.sourceFileId) {
      await this.flushAll();
      log("INFO", `Session ended`, {
        sessionId: this.sessionId,
        sourceFileId: this.sourceFileId.toString(),
        totalChunks: this.chunkIndex,
        totalBytesFlushed: this.bytesFlushed,
        bufferRemaining: this.bufferByteLength,
      });
    }

    this.freeDecoder();
  }

  freeDecoder(): void {
    if (this.opusDecoder) {
      try {
        this.opusDecoder.free();
        log("INFO", `[AUDIO_WS] Freed in-process Opus decoder`, {
          sessionId: this.sessionId,
          framesDecoded: this.opusFrameCount,
        });
      } catch (error) {
        log("WARN", `[AUDIO_WS] Exception freeing Opus decoder`, {
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.opusDecoder = null;
    }
  }

  async addAudioData(audioData: Uint8Array): Promise<void> {
    if (!this.sourceFileId) {
      return;
    }

    this.messagesReceived++;
    this.bytesReceived += audioData.byteLength;

    // For Opus: Decode frame-by-frame to PCM (like Chronicle), then buffer PCM
    // CRITICAL: Serialize decoding to prevent concurrent decoder access (Chronicle pattern)
    if (this.detectedFormat === "opus") {
      this.opusFrameCount++;

      if (this.messagesReceived === 1) {
        log(
          "INFO",
          `[AUDIO_WS] Opus detected - decoding frames to PCM (serialized)`,
          {
            sessionId: this.sessionId,
            opusFrameSize: audioData.byteLength,
          },
        );
      }

      // Serialize Opus decoding (like Chronicle's sequential while loop)
      // IN-PROCESS WASM decoding - zero HTTP overhead!
      await this.opusDecodeLock.acquire(async () => {
        const decodeStartTime = performance.now();
        try {
          if (!this.opusDecoder) {
            log("ERROR", `[OPUS_DECODE] Decoder not initialized`, {
              sessionId: this.sessionId,
              frameNumber: this.opusFrameCount,
            });
            return;
          }

          // Decode frame using in-process WASM decoder (maintains state)
          const wasmDecodeStart = performance.now();
          const result = this.opusDecoder.decodeFrame(audioData);
          const wasmDecodeMs = performance.now() - wasmDecodeStart;

          if (result.samplesDecoded > 0 && result.channelData.length > 0) {
            // Convert Float32Array PCM to Int16 PCM bytes
            const float32Pcm = result.channelData[0]; // Mono channel
            const int16Pcm = new Int16Array(float32Pcm.length);

            for (let i = 0; i < float32Pcm.length; i++) {
              // Clamp to [-1, 1] and convert to 16-bit int range [-32768, 32767]
              const sample = Math.max(-1, Math.min(1, float32Pcm[i]));
              int16Pcm[i] = Math.round(sample * 32767);
            }

            // Convert Int16Array to bytes and buffer them
            const pcmBytes = new Uint8Array(
              int16Pcm.buffer.slice(
                int16Pcm.byteOffset,
                int16Pcm.byteOffset + int16Pcm.byteLength,
              ),
            );
            this.buffer.push(pcmBytes);
            this.bufferByteLength += pcmBytes.length;

            // Log any errors from decoder
            if (result.errors && result.errors.length > 0) {
              for (const error of result.errors) {
                log(
                  "WARN",
                  `[OPUS_DECODE] Decoder error at frame ${this.opusFrameCount}`,
                  {
                    sessionId: this.sessionId,
                    error: error.message,
                  },
                );
              }
            }
          }

          // Log every 50 frames with statistics
          if (this.opusFrameCount % 50 === 0) {
            log("INFO", `[OPUS_DECODE] Progress checkpoint`, {
              sessionId: this.sessionId,
              framesProcessed: this.opusFrameCount,
              bufferedPcmBytes: this.bufferByteLength,
              targetChunkSize: this.bytesPerChunk,
              fillPercentage:
                ((this.bufferByteLength / this.bytesPerChunk) * 100).toFixed(1),
            });
          }

          // Flush when buffer reaches target size (bytesPerChunk is set to PCM byte count)
          if (this.bufferByteLength >= this.bytesPerChunk) {
            log("INFO", `[OPUS_DECODE] Buffer full - flushing chunk`, {
              sessionId: this.sessionId,
              frameNumber: this.opusFrameCount,
              bufferedBytes: this.bufferByteLength,
              targetBytes: this.bytesPerChunk,
            });
            await this.flush(false);
          }
        } catch (error) {
          const errorMsg = error instanceof Error
            ? error.message
            : String(error);
          log("ERROR", `[OPUS_DECODE] Exception in WASM decoder`, {
            sessionId: this.sessionId,
            frameNumber: this.opusFrameCount,
            error: errorMsg,
          });
          // Continue processing other frames
        }
      });

      return;
    }

    // Ensure audio data is properly aligned to sample width BEFORE format detection
    // Note: Skip alignment for Opus (width=0) since Opus frames are variable-length
    // (but we've already decoded Opus to PCM above, so this only applies to non-Opus)
    let alignedData = audioData;
    if (
      this.audioFormat && this.audioFormat.width > 0 &&
      audioData.byteLength % this.audioFormat.width !== 0
    ) {
      const misalignment = audioData.byteLength % this.audioFormat.width;
      const alignedLength = audioData.byteLength - misalignment;

      log(
        "WARN",
        `[AUDIO_WS] Audio data alignment issue - truncating ${misalignment} bytes`,
        {
          sessionId: this.sessionId,
          originalLength: audioData.byteLength,
          alignedLength,
          sampleWidth: this.audioFormat.width,
          bitsPerSample: this.audioFormat.width * 8,
        },
      );

      // Truncate to aligned boundary (drop incomplete sample at end)
      alignedData = audioData.slice(0, alignedLength);
    }

    // Trust the format from the header (don't override with detection)
    // The phone declares width=2 (16-bit PCM), so use that for chunk calculations

    // Log periodically (every 100 messages) to avoid flooding
    if (this.messagesReceived % 100 === 0) {
      log("DEBUG", `[AUDIO_WS] Audio data progress`, {
        sessionId: this.sessionId,
        messagesReceived: this.messagesReceived,
        bytesReceived: this.bytesReceived,
        bufferSize: this.bufferByteLength,
        chunksCreated: this.chunkIndex,
        detectedFormat: this.detectedFormat,
        opusDecodedToPcm: this.opusDecodedToPcm,
      });
    }

    this.buffer.push(alignedData);
    this.bufferByteLength += alignedData.length;
    await this.checkAndFlushIfNeeded();
  }

  private calculateTimeFromBytes(bytes: number): number {
    if (!this.audioFormat) {
      return 0;
    }
    // For Opus (width=0), use frame-based calculation
    let bytesPerSecond: number;
    if (this.audioFormat.width === 0) {
      // Opus: 20ms frames, ~320 bytes/frame, 50 frames/sec
      const OPUS_FRAME_SIZE_BYTES = 320;
      const OPUS_FRAMES_PER_SECOND = 50;
      bytesPerSecond = OPUS_FRAME_SIZE_BYTES * OPUS_FRAMES_PER_SECOND;
    } else {
      // PCM or float: rate * width * channels
      bytesPerSecond = this.audioFormat.rate * this.audioFormat.width *
        this.audioFormat.channels;
    }
    return bytes / bytesPerSecond;
  }

  private calculateChunkStartTime(): Date {
    if (!this.startedAt || !this.audioFormat) {
      return new Date();
    }
    const secondsOffset = this.calculateTimeFromBytes(this.bytesFlushed);
    return new Date(this.startedAt.getTime() + secondsOffset * 1000);
  }

  private getBufferSize(): number {
    return this.bufferByteLength;
  }

  private async checkAndFlushIfNeeded(): Promise<void> {
    if (!this.sourceFileId || !this.audioFormat) {
      return;
    }

    if (this.bytesPerChunk === 0) {
      return;
    }

    await this.flushLock.acquire(async () => {
      const currentBufferSize = this.getBufferSize();
      if (currentBufferSize < this.bytesPerChunk) {
        return;
      }

      const numberOfChunks = Math.floor(currentBufferSize / this.bytesPerChunk);

      for (let i = 0; i < numberOfChunks; i++) {
        const remainingBufferSize = this.getBufferSize();
        if (remainingBufferSize < this.bytesPerChunk) {
          break;
        }
        await this.performFlush();
      }
    });
  }

  private async flush(flushAll: boolean = false): Promise<void> {
    if (
      !this.sourceFileId || !this.startedAt || !this.audioFormat ||
      !this.bufferByteLength
    ) {
      return;
    }

    while (this.bufferByteLength > 0) {
      // Use byte count for all formats (Opus is already decoded to PCM)
      const hasWholeChunk = this.bufferByteLength >= this.bytesPerChunk;

      if (!flushAll && !hasWholeChunk) {
        break;
      }

      // Flush exactly bytesPerChunk bytes (or remaining if flushAll)
      const bytesToFlush = flushAll
        ? this.bufferByteLength
        : this.bytesPerChunk;

      if (bytesToFlush === 0) {
        break;
      }

      const audioData = new Uint8Array(bytesToFlush);
      let written = 0;

      while (written < bytesToFlush && this.buffer.length > 0) {
        const chunk = this.buffer.peekFront()!;
        const needed = bytesToFlush - written;
        if (chunk.length <= needed) {
          audioData.set(chunk, written);
          written += chunk.length;
          this.buffer.shift();
          this.bufferByteLength -= chunk.length;
        } else {
          audioData.set(chunk.subarray(0, needed), written);
          this.buffer.shift();
          this.buffer.unshift(chunk.subarray(needed));
          this.bufferByteLength -= needed;
          written += needed;
        }
      }

      const chunkStartTime = this.calculateChunkStartTime();

      // For Opus: we decoded to PCM, so buffer contains PCM now
      // For PCM/float32: buffer contains what header declared
      const format: AudioFormatConfig["format"] =
        this.detectedFormat === "float32" ? "float32" : "pcm";

      const formatConfig: AudioFormatConfig = {
        format,
        sampleRate: this.audioFormat?.rate || 16000,
        channels: this.audioFormat?.channels || 1,
      };

      try {
        await createAudioChunk(
          audioData,
          chunkStartTime,
          this.chunkIndex,
          this.sourceFileId,
          formatConfig,
        );
        log("INFO", `[AUDIO_WS] Audio chunk created`, {
          sessionId: this.sessionId,
          chunkIndex: this.chunkIndex,
          chunkBytes: audioData.length,
          chunkStart: chunkStartTime.toISOString(),
          isFinal: flushAll,
          sourceFileId: this.sourceFileId?.toString(),
          format: formatConfig.format,
          sampleRate: formatConfig.sampleRate,
          channels: formatConfig.channels,
        });
        this.bytesFlushed += audioData.length;
        this.chunkIndex++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log("ERROR", `[AUDIO_WS] Failed to create audio chunk`, {
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
    // Parse errors can happen with partial data - only log in debug mode
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
    "audio-pcm:ping",
  );
}

export async function handlePcmWebSocket(
  ws: WebSocket | any,
  upgrade: IncomingMessage,
): Promise<void> {
  const request = createWebSocketAuthRequest(upgrade);
  log("INFO", `[AUDIO_WS] WebSocket connection attempt`, {
    path: request ? new URL(request.url).pathname : "invalid",
    remoteAddress: upgrade.socket?.remoteAddress,
  });

  const auth = request ? await authenticate(request) : null;

  if (ws.readyState !== WS_OPEN) {
    log("INFO", `[AUDIO_WS] WebSocket closed during authentication`);
    return;
  }

  if (!auth) {
    log("WARN", `[AUDIO_WS] WebSocket auth failed`);
    closeWebSocket(
      ws,
      1008,
      "Unauthorized: Token is missing or invalid",
      "audio-pcm:auth",
    );
    throw new Error("Unauthorized");
  }

  log("INFO", `[AUDIO_WS] WebSocket authenticated`, {
    principal: auth.principal,
  });

  await defaultResourceManager.ensureAllowed(
    auth,
    { path: "live.audio", actions: ["write"] },
  );

  if (ws.readyState !== WS_OPEN) {
    log("INFO", `[AUDIO_WS] WebSocket closed during authorization`);
    return;
  }

  return new Promise((resolve, reject) => {
    const session = new PcmWebSocketSession(auth, ws);
    const payloadHandler = new WyomingPayloadHandler();
    let textBuffer = "";

    const handleBinaryMessage = async (data: any): Promise<void> => {
      const binaryData = normalizeBinaryData(data);

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
                await session.addAudioData(payloadData);
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
                await session.addAudioData(payload);
              }
            }
            return;
          }
        }
      }

      const payloadResult = payloadHandler.addChunk(binaryData);
      if (payloadResult) {
        const { payload, messageType } = payloadResult;
        if (messageType === "audio-chunk") {
          await session.addAudioData(payload);
        }
      } else if (!payloadHandler.isExpectingPayload) {
        await session.addAudioData(binaryData);
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
        log("ERROR", `[AUDIO_WS] Message task failed`, {
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
          log("ERROR", `[AUDIO_WS] Error flushing buffer on cleanup`, {
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
                "WebSocket failed while finalizing buffered PCM audio",
              )
              : finalizationError,
          ),
      );
    };

    const failSession = (error: Error): void => {
      terminalError ??= error;
      settleAfterFinalize();
      terminateWebSocket(ws, "audio-pcm");
    };

    const handleError = (error: Error) => {
      log("ERROR", `WebSocket error`, {
        error: error.message,
        stack: error.stack,
      });
      failSession(error);
    };

    const handleClose = (code: number, reason: Buffer) => {
      const reasonStr = reason ? reason.toString() : "";
      log("INFO", `[AUDIO_WS] WebSocket closed`, { code, reason: reasonStr });
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
      log("INFO", `[AUDIO_WS] WebSocket closed during session setup`);
      settleAfterFinalize();
    }
  });
}
