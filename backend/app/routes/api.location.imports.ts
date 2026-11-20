import type { Request, Response } from "express";
import multer from "multer";
import { authenticateOr401 } from "@/lib/auth/core.server.ts";
import {
  analyzeLocationFile,
  confirmLocationPreview,
  StaleLocationPreviewError,
} from "@/lib/location/import.server.ts";
import { locationProviderSchema } from "@/lib/location/sources.server.ts";
import { asyncHandler } from "@/middleware/asyncHandler.ts";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});
const uploadMiddleware = upload.array("files", 20);

function receiveFiles(req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    uploadMiddleware(req, res, (error: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function publicError(error: unknown): { code: string; message: string } {
  const code = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "UNSUPPORTED_FORMAT":
      return {
        code: "unsupported_format",
        message: "Unsupported format. Choose a GPX, KML or KMZ file.",
      };
    case "NO_LOCATION_DATA":
      return {
        code: "no_location_data",
        message: "No tracks, routes or saved places were found in this file.",
      };
    default:
      return {
        code: "analysis_failed",
        message:
          "The file could not be analyzed. No timeline data was changed.",
      };
  }
}

export const apiLocationImportsAnalyzeHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const auth = await authenticateOr401(req, res);
    await receiveFiles(req, res);
    const files = req.files as multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ error: "At least one track file is required" });
      return;
    }

    const results = [];
    for (const file of files) {
      try {
        results.push(
          await analyzeLocationFile(auth, {
            originalname: file.originalname,
            mimetype: file.mimetype,
            buffer: new Uint8Array(file.buffer),
          }),
        );
      } catch (error) {
        const safe = publicError(error);
        console.error(
          `[location-import] Analysis failed for ${file.originalname}:`,
          error instanceof Error ? error.message : error,
        );
        results.push({ filename: file.originalname, error: safe });
      }
    }
    res.json({
      success: results.some((result) => !("error" in result)),
      results,
    });
  },
);

export const apiLocationImportsConfirmHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const auth = await authenticateOr401(req, res);
    const provider = locationProviderSchema.optional().safeParse(req.body?.provider);
    if (!provider.success) {
      res.status(400).json({ error: { message: "Invalid source application." } });
      return;
    }
    try {
      const receipt = await confirmLocationPreview(
        auth,
        req.params.previewId,
        provider.data ? { provider: provider.data, evidence: "confirmed" } : undefined,
      );
      res.json({ success: true, receipt });
    } catch (error) {
      if (error instanceof StaleLocationPreviewError) {
        res.status(409).json({
          success: false,
          error: {
            code: "preview_stale",
            message: "Location data changed. Review the refreshed analysis.",
          },
          preview: error.refreshed,
        });
        return;
      }
      const code = error instanceof Error ? error.message : String(error);
      if (code === "PREVIEW_COMMITTING") {
        res.status(409).json({
          success: false,
          error: {
            code: "preview_committing",
            message: "This import is already being committed.",
          },
        });
        return;
      }
      const notFound = code === "PREVIEW_NOT_FOUND" ||
        code === "PREVIEW_FILE_MISSING";
      console.error("[location-import] Confirm failed:", code);
      res.status(notFound ? 404 : 500).json({
        success: false,
        error: {
          code: notFound ? "preview_not_found" : "confirm_failed",
          message: notFound
            ? "This import preview expired. Analyze the file again."
            : "The import could not be committed. No partial track is visible.",
        },
      });
    }
  },
);
