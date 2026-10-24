import { IDEMPOTENCY_PENDING_TIMEOUT_MS } from "../db/repositories/idempotency.repo";

/**
 * Every outbound call carries a deadline well inside IDEMPOTENCY_PENDING_TIMEOUT_MS: a request
 * still hung when its idempotency reservation is taken over as stale could otherwise complete
 * a second time next to its replacement.
 *
 * Not applied to the Turnkey SDK's own HTTP calls, which expose no per-call signal; that
 * client is assumed to fail within the same bound on its own transport timeouts.
 */
export const UPSTREAM_TIMEOUT_MS = Math.min(60_000, IDEMPOTENCY_PENDING_TIMEOUT_MS / 4);

export function upstreamSignal(): AbortSignal {
  return AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
}
