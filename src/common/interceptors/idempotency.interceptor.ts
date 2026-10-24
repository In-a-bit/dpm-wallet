import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { keccak256, toHex } from "viem";
import { catchError, concatMap, from, of, throwError, type Observable } from "rxjs";

import {
  IDEMPOTENCY_PENDING_TIMEOUT_MS,
  IdempotencyRepository,
  type IdempotencyRecord,
} from "../../db/repositories/idempotency.repo";
import { DpmwError } from "../../errors";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * Replays the stored response when a POST is retried with the same `Idempotency-Key` and the
 * same body, and rejects the same key with a different body. Without this a client retrying
 * after a timeout would get a second, differently-salted signature for one intended action.
 *
 * Applies only to authenticated POST routes, and a key is scoped to the method and route it
 * arrived on: the same value sent to two routes is two requests, so a key cannot replay a
 * response from an unrelated endpoint.
 *
 * The key is reserved before the handler runs, so a duplicate that arrives while the first is
 * still in flight is refused (IDEMPOTENCY_IN_PROGRESS) rather than executing a second time.
 * Only successful responses are kept: a failure releases the reservation, so a retry after a
 * transient error still reaches the handler.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly repository: IdempotencyRepository,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.header(IDEMPOTENCY_KEY_HEADER)?.trim();
    if (!header || request.method !== "POST" || this.isPublic(context)) return next.handle();

    const key = `${request.method} ${(request.route as { path?: string } | undefined)?.path ?? request.path}\n${header}`;
    // Hashed from the raw body: pipes transform the handler's argument, not the request, so
    // this sees exactly what the client sent, as the Express middleware did.
    const requestHash = hashBody(request.body);

    if (!(await this.reserve(key, requestHash))) {
      const stored = await this.repository.find(key);
      // Released between the failed reserve and the read: the first request failed, so this
      // one is simply the retry.
      if (!stored) return this.intercept(context, next);
      return of(replayOrConflict(stored, requestHash));
    }

    // The response is committed before it is emitted, not alongside it: a client that
    // receives the response and immediately retries must find the key complete, or it gets a
    // second signature for the one action this exists to prevent.
    return next.handle().pipe(
      concatMap(async (body: unknown) => {
        await this.repository.complete(key, JSON.stringify(body));
        return body;
      }),
      catchError((error: unknown) =>
        from(this.repository.release(key)).pipe(concatMap(() => throwError(() => error))),
      ),
    );
  }

  private async reserve(key: string, requestHash: string): Promise<boolean> {
    const now = Date.now();
    if (await this.repository.reserve(key, requestHash, new Date(now).toISOString())) return true;
    const cutoff = new Date(now - IDEMPOTENCY_PENDING_TIMEOUT_MS).toISOString();
    if (!(await this.repository.releaseIfStale(key, cutoff))) return false;
    return this.repository.reserve(key, requestHash, new Date().toISOString());
  }

  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}

function replayOrConflict(stored: IdempotencyRecord, requestHash: string): unknown {
  if (stored.requestHash !== requestHash) {
    throw new DpmwError(
      "IDEMPOTENCY_CONFLICT",
      "This Idempotency-Key was used with a different request body",
    );
  }
  if (stored.responseJson === undefined) {
    throw new DpmwError(
      "IDEMPOTENCY_IN_PROGRESS",
      "A request with this Idempotency-Key is still running; retry shortly",
    );
  }
  return JSON.parse(stored.responseJson);
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
