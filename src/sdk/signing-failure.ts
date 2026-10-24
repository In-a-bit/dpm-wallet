import { SigningError } from "@inabit-com/dpm-sdk/turnkey";

import { DpmwError } from "../errors";

/**
 * Maps the SDK's signing failure onto the code the gateway branches on. The SDK's message
 * (which names the Turnkey activity) is logged with a request id, not returned.
 *
 * Returns undefined for anything else, so a caller can go on to classify it.
 */
export function translateSigningFailure(cause: unknown): DpmwError | undefined {
  if (!(cause instanceof SigningError)) return undefined;
  return new DpmwError("SIGNING_FAILED", "Signing failed", { cause, internal: cause.message });
}
