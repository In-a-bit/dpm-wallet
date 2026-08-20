import { timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

import { unauthorized } from "../../errors.js";

export const API_KEY_HEADER = "x-api-key";

/**
 * The operator gateway's key *into* this service — unrelated to the builder key this service
 * sends *out* to `relayer-api`.
 */
export function apiKeyAuth(expectedKey: string): RequestHandler {
  const expected = Buffer.from(expectedKey);
  return (req, _res, next) => {
    const presented = req.header(API_KEY_HEADER);
    if (!presented || !constantTimeEquals(Buffer.from(presented), expected)) {
      next(unauthorized());
      return;
    }
    next();
  };
}

/**
 * Comparing lengths first is unavoidable — `timingSafeEqual` throws on a mismatch — and
 * harmless: the length of the expected key is not the secret.
 */
function constantTimeEquals(presented: Buffer, expected: Buffer): boolean {
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
