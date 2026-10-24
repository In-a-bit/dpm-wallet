import { IDEMPOTENCY_PENDING_TIMEOUT_MS } from "../db/repositories/idempotency.repo";

/**
 * Every outbound call carries a deadline well inside IDEMPOTENCY_PENDING_TIMEOUT_MS: a request
 * still hung when its idempotency reservation is taken over as stale could otherwise complete
 * a second time next to its replacement.
 *
 * The Turnkey SDK's calls expose no per-call signal, so they are bounded with `withDeadline`
 * instead: the caller gets a failure at the deadline (the request itself may still finish
 * upstream, which is why the deadline sits well below the stale takeover).
 */
export const UPSTREAM_TIMEOUT_MS = Math.min(60_000, IDEMPOTENCY_PENDING_TIMEOUT_MS / 4);

export function upstreamSignal(): AbortSignal {
  return AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
}

/** Rejects after `ms` if `work` has not settled; the timer never outlives the work. */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
