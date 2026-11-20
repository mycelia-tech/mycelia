import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Handle Zod validation errors
  let zodIssues: any[] | null = null;

  if (error instanceof ZodError) {
    zodIssues = error.issues;
  } else if (error && typeof error === "object") {
    const errorObj = error as any;

    // Check if it has issues property directly
    if ("issues" in errorObj && Array.isArray(errorObj.issues)) {
      zodIssues = errorObj.issues;
    } // Check if error.message is a stringified JSON array
    else if (errorObj.message && typeof errorObj.message === "string") {
      // Check if message looks like stringified Zod error
      if (
        errorObj.message.includes("invalid_union_discriminator") ||
        errorObj.message.startsWith("[")
      ) {
        try {
          const parsed = JSON.parse(errorObj.message);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].code) {
            zodIssues = parsed;
          }
        } catch {
          // Not parseable JSON, continue
        }
      }
    }
  }

  if (zodIssues) {
    res.status(400).json({
      success: false,
      error: zodIssues,
    });
    return;
  }

  // Handle unauthorized errors
  if (error instanceof Error && error.message === "Unauthorized") {
    // Response already sent by authenticateOr401
    return;
  }

  // Handle Response objects (from permissionDenied, etc.)
  if (error instanceof globalThis.Response) {
    error.json().then((body) => {
      res.status(error.status).json(body);
    }).catch(() => {
      res.status(error.status).send();
    });
    return;
  }

  // Default error handling
  const requestId = res.getHeader("X-Mycelia-Request-Id");
  if (typeof requestId === "string" && !res.headersSent) {
    console.error("Chat request failed", { requestId, path: req.path, error });
    res.status(500).json({
      success: false,
      error: "Mycelia failed while preparing or saving the chat request.",
      requestId,
    });
    return;
  }
  console.error("Unhandled error:", error);
  console.error("Error type:", error?.constructor?.name);
  console.error(
    "Stack trace:",
    error instanceof Error ? error.stack : "No stack trace available",
  );

  const isProduction = (Deno.env.get("APP_MODE") ?? "prod") !== "dev";
  res.status(500).json({
    success: false,
    error: isProduction
      ? "Internal server error"
      : (error instanceof Error ? error.message : String(error)),
  });
}
