import type { Request, Response } from "express";
import { authenticateOr401 } from "@/lib/auth/core.server.ts";
import {
  createAudioChunk,
  createSourceFile,
} from "@/services/streaming.server.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import multer from "multer";
import { asyncHandler } from "@/middleware/asyncHandler.ts";
import {
  AudioUploadLimitError,
  boundedAudioStorage,
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_AUDIO_UPLOAD_FILES,
  processAudioPath,
} from "@/services/audio-upload.server.ts";

let activeUploads = 0;

const uploadDependencies = {
  authenticateOr401,
  createSourceFile,
  createAudioChunk,
  getMongoResource,
  processAudioPath,
};

export function createAudioUploadHandler(dependencies = uploadDependencies) {
  const {
    authenticateOr401,
    createSourceFile,
    createAudioChunk,
    getMongoResource,
    processAudioPath,
  } = dependencies;
  return asyncHandler(
    async (req: Request, res: Response) => {
      const auth = await authenticateOr401(req, res);
      if (activeUploads >= 2) {
        res.setHeader("Retry-After", "10");
        res.status(429).json({
          error: "Audio upload capacity is busy; try again shortly",
        });
        return;
      }
      activeUploads++;
      let directory: string | undefined;
      const cancellation = new AbortController();
      const onAborted = () => cancellation.abort();
      const onClosed = () => {
        if (!res.writableEnded) cancellation.abort();
      };
      req.once("aborted", onAborted);
      res.once("close", onClosed);
      try {
        directory = await Deno.makeTempDir({ prefix: "mycelia-audio-upload-" });
        const upload = multer({
          storage: boundedAudioStorage(directory),
          limits: {
            fileSize: MAX_AUDIO_UPLOAD_BYTES,
            files: MAX_AUDIO_UPLOAD_FILES,
            fields: 0,
            parts: MAX_AUDIO_UPLOAD_FILES,
          },
        }).array("files", MAX_AUDIO_UPLOAD_FILES);
        try {
          await new Promise<void>((resolve, reject) =>
            upload(
              req,
              res,
              (error: Error | null) => error ? reject(error) : resolve(),
            )
          );
        } catch (error) {
          if (
            error instanceof AudioUploadLimitError ||
            error instanceof multer.MulterError
          ) {
            res.status(413).json({
              error: "Upload accepts up to 20 audio files and 500 MiB in total",
            });
            return;
          }
          throw error;
        }
        const files = req.files as multer.File[] | undefined;
        if (!files?.length) {
          res.status(400).json({
            error: "At least one audio file is required",
          });
          return;
        }
        const mongoResource = await getMongoResource(auth);
        const results: Array<{
          filename: string;
          sourceFileId: string;
          chunks: number;
          durationMs: number;
          error?: string;
        }> = [];

        for (const file of files) {
          let sourceFileId:
            | Awaited<ReturnType<typeof createSourceFile>>
            | undefined;
          let chunks = 0;
          try {
            cancellation.signal.throwIfAborted();
            const startTime = new Date();
            // Create source file record
            sourceFileId = await createSourceFile(
              startTime,
              file.size,
              file.originalname,
              { originalMimetype: file.mimetype },
              auth.principal || "web",
            );

            const selectedSourceId = sourceFileId;
            const processed = await processAudioPath(
              file.path,
              async (audio, index, offsetMs) => {
                await createAudioChunk(
                  audio,
                  new Date(startTime.getTime() + offsetMs),
                  index,
                  selectedSourceId,
                  "opus",
                );
                chunks++;
              },
              { signal: cancellation.signal },
            );

            // Mark source file as ingested
            await mongoResource({
              action: "updateOne",
              collection: "source_files",
              query: { _id: sourceFileId },
              update: {
                $set: {
                  ingested: true,
                  ingested_at: new Date(),
                  processing_status: "complete",
                  duration: processed.durationMs / 1000,
                },
              },
            });

            results.push({
              filename: file.originalname,
              sourceFileId: sourceFileId.toString(),
              chunks,
              durationMs: processed.durationMs,
            });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            if (sourceFileId) {
              // Preserve completed chunks and the failure record; never pretend an
              // interrupted upload completed or clear its history from a UI click.
              await mongoResource({
                action: "updateOne",
                collection: "source_files",
                query: { _id: sourceFileId },
                update: {
                  $set: {
                    ingested: false,
                    processing_status: "failed",
                    ingestion: {
                      error: errorMsg,
                      last_attempt: new Date(),
                      completed_chunks: chunks,
                      recovery: "reupload", // Request staging is temporary; no host path exists.
                    },
                  },
                },
              });
            }
            results.push({
              filename: file.originalname,
              sourceFileId: sourceFileId?.toString() ?? "",
              chunks,
              durationMs: 0,
              error: errorMsg,
            });
          } finally {
            await Deno.remove(file.path).catch(() => {});
          }
          if (cancellation.signal.aborted) break;
        }

        const successCount = results.filter((r) => !r.error).length;
        res.json({
          success: successCount > 0,
          processed: successCount,
          failed: results.length - successCount,
          results,
        });
      } finally {
        req.off("aborted", onAborted);
        res.off("close", onClosed);
        try {
          if (directory) await Deno.remove(directory, { recursive: true });
        } finally {
          activeUploads--;
        }
      }
    },
  );
}

export const apiAudioUploadHandler = createAudioUploadHandler();
