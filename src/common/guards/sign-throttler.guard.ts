import { Injectable, type ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { createHash } from "node:crypto";

/**
 * The stock guard keeps a separate budget per handler, which would give every signing route its
 * own SIGN_RATE_LIMIT_PER_MIN. One shared bucket per client is the ceiling the setting names.
 */
@Injectable()
export class SignThrottlerGuard extends ThrottlerGuard {
  protected override generateKey(
    _context: ExecutionContext,
    tracker: string,
    name: string,
  ): string {
    return createHash("sha256").update(`sign:${name}:${tracker}`).digest("hex");
  }
}
