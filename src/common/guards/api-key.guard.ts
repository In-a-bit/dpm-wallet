import { timingSafeEqual } from "node:crypto";

import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import type { Config } from "../../config";
import { unauthorized } from "../../errors";
import { CONFIG } from "../../tokens";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";

export const API_KEY_HEADER = "x-api-key";

/**
 * The operator gateway's key *into* this service — unrelated to the builder key this service
 * sends *out* to `relayer-api`.
 *
 * Registered globally, so a new controller is guarded by default and has to opt out with
 * `@Public()` rather than remembering to opt in.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(
    @Inject(CONFIG) config: Config,
    private readonly reflector: Reflector,
  ) {
    this.expected = Buffer.from(config.apiKey);
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.isPublic(context)) return true;

    if (!hasValidApiKey(context.switchToHttp().getRequest<Request>(), this.expected)) {
      throw unauthorized();
    }
    return true;
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

/** Whether the request presents the expected key; shared by the guard and the public health route. */
export function hasValidApiKey(req: Request, expected: Buffer): boolean {
  const presented = req.header(API_KEY_HEADER);
  return presented !== undefined && constantTimeEquals(Buffer.from(presented), expected);
}

/**
 * Comparing lengths first is unavoidable — `timingSafeEqual` throws on a mismatch — and
 * harmless: the length of the expected key is not the secret.
 */
function constantTimeEquals(presented: Buffer, expected: Buffer): boolean {
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
