import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

import { DpmwError, ERROR_STATUS, type ErrorEnvelope } from "../../errors.js";
import { logError, logWarn } from "../../observability/log.js";

/** Errors at or above this status indicate a fault here rather than a bad request. */
const SERVER_ERROR_THRESHOLD = 500;

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(envelope("ADDRESS_NOT_FOUND", `No route for ${req.method} ${req.path}`));
};

/**
 * The single place an exception becomes a response. Anything that is not a DpmwError or a
 * zod error is treated as a bug: it is logged in full and reported as INTERNAL_ERROR with a
 * generic message, so an unexpected failure cannot leak internals through the envelope.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const { status, body } = toResponse(err);
  const context = { method: req.method, path: req.path, code: body.error.code, err };
  if (status >= SERVER_ERROR_THRESHOLD) {
    logError("request.failed", context);
  } else {
    logWarn("request.rejected", context);
  }
  res.status(status).json(body);
};

function toResponse(err: unknown): { status: number; body: ErrorEnvelope } {
  if (err instanceof DpmwError) {
    return { status: err.status, body: err.toEnvelope() };
  }
  if (err instanceof ZodError) {
    return {
      status: ERROR_STATUS.VALIDATION_FAILED,
      body: envelope("VALIDATION_FAILED", "Request validation failed", {
        issues: err.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      }),
    };
  }
  return {
    status: ERROR_STATUS.INTERNAL_ERROR,
    body: envelope("INTERNAL_ERROR", "Unexpected error"),
  };
}

function envelope(
  code: ErrorEnvelope["error"]["code"],
  message: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return { error: { code, message, ...(details ? { details } : {}) } };
}
