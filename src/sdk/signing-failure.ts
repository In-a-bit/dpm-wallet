import { SigningError } from "@inabit-com/dpm-sdk/turnkey";

import { DpmwError } from "../errors";

/**
 * Maps the SDK's signing failure onto the code the gateway branches on. The SDK's message
 * already names the failed activity and carries no credential, so it is passed through
 * rather than replaced with a generic one that would tell an operator nothing.
 *
 * Returns undefined for anything else, so a caller can go on to classify it.
 */
export function translateSigningFailure(cause: unknown): DpmwError | undefined {
  if (!(cause instanceof SigningError)) return undefined;
  return new DpmwError("SIGNING_FAILED", cause.message, { cause });
}
