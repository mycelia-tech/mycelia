import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";

const parserErrorStatuses = new Map<string, number>([
  ["entity.parse.failed", 400],
  ["request.aborted", 400],
  ["request.size.invalid", 400],
  ["querystring.parse.rangeError", 400],
  ["entity.too.large", 413],
  ["parameters.too.many", 413],
  ["charset.unsupported", 415],
  ["encoding.unsupported", 415],
]);

function handleParserError(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!error || typeof error !== "object" || res.headersSent) {
    next(error);
    return;
  }
  const parserError = error as {
    type?: unknown;
    status?: unknown;
    code?: unknown;
  };
  const expectedStatus = typeof parserError.type === "string"
    ? parserErrorStatuses.get(parserError.type)
    : undefined;
  // zlib errors have a code rather than a body-parser type. Require the
  // parser's HTTP status too; unrelated errors keep the application's handler.
  const invalidCompression = parserError.status === 400 &&
    typeof parserError.code === "string" &&
    ["Z_DATA_ERROR", "Z_BUF_ERROR", "Z_NEED_DICT"].includes(parserError.code);
  const status = expectedStatus === parserError.status
    ? expectedStatus
    : invalidCompression
    ? 400
    : undefined;
  if (!status) {
    next(error);
    return;
  }
  // Parser errors may carry the raw body and submitted credentials. Return
  // only a fixed message, without forwarding them to the application logger.
  res.status(status).json({ success: false, error: "Invalid request body" });
}

type BodyParserOptions = {
  limit?: number | string;
  parameterLimit?: number;
};

// Preserve the application's parser limits and form behavior. Optional limits
// let disposable middleware tests exercise rejection with small ordinary bodies.
export function createBodyParsers(
  { limit = "50mb", parameterLimit = 1000 }: BodyParserOptions = {},
): [RequestHandler, RequestHandler, ErrorRequestHandler] {
  return [
    express.json({ limit }),
    express.urlencoded({ extended: true, limit, parameterLimit }),
    handleParserError,
  ];
}
