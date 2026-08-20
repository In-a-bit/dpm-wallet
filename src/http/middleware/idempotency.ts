import type { Response, RequestHandler } from "express";
import { keccak256, toHex } from "viem";

import type { IdempotencyRepository } from "../../db/repositories/idempotency.repo.js";
import { DpmwError } from "../../errors.js";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

const OK_STATUS = 200;
const REDIRECT_STATUS = 300;

/**
 * Replays the stored response when a POST is retried with the same `Idempotency-Key` and the
 * same body, and rejects the same key with a different body. Without this a client retrying
 * after a timeout would get a second, differently-salted signature for one intended action.
 *
 * Only successful responses are stored, so a retry after a transient failure still reaches
 * the handler.
 */
export function idempotency(
  repository: IdempotencyRepository,
  now: () => string = () => new Date().toISOString(),
): RequestHandler {
  return (req, res, next) => {
    const key = req.header(IDEMPOTENCY_KEY_HEADER)?.trim();
    if (!key) {
      next();
      return;
    }

    const requestHash = hashBody(req.body);
    const stored = repository.find(key);
    if (stored) {
      replayOrConflict(res, next, stored, requestHash);
      return;
    }

    storeOnSuccess(res, (responseJson) => {
      repository.save(key, { requestHash, responseJson }, now());
    });
    next();
  };
}

function replayOrConflict(
  res: Response,
  next: (err?: unknown) => void,
  stored: { requestHash: string; responseJson: string },
  requestHash: string,
): void {
  if (stored.requestHash !== requestHash) {
    next(
      new DpmwError(
        "IDEMPOTENCY_CONFLICT",
        "This Idempotency-Key was used with a different request body",
      ),
    );
    return;
  }
  res.type("application/json").send(stored.responseJson);
}

/**
 * Wraps `res.json` rather than listening for "finish", because the body is only available
 * before Express serialises it and the record must include the exact bytes to replay.
 */
function storeOnSuccess(res: Response, store: (responseJson: string) => void): void {
  const sendJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (isSuccess(res.statusCode)) store(JSON.stringify(body));
    return sendJson(body);
  };
}

function isSuccess(statusCode: number): boolean {
  return statusCode >= OK_STATUS && statusCode < REDIRECT_STATUS;
}

/** Hashes the parsed body so key ordering and whitespace cannot make one request look like two. */
function hashBody(body: unknown): string {
  return keccak256(toHex(canonicalize(body)));
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
  return `{${entries.join(",")}}`;
}
