import { timingSafeEqual } from "node:crypto";

import { Controller, Get, Inject, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";

import { Public } from "../common/decorators/public.decorator";
import type { Db } from "../db/client";
import type { Config } from "../config";
import { API_KEY_HEADER } from "../common/guards/api-key.guard";
import { CONFIG, DB } from "../tokens";
import { TurnkeyKeyVault } from "../vault/turnkey-vault";
import type { VaultHealth } from "../vault/key-vault.interface";

/** A probe must answer inside the healthcheck timeout even when the database hangs. */
const READY_TIMEOUT_MS = 3000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("readiness query timed out")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** The vault's reachability is looked up at most this often; probes and the manager poll. */
const VAULT_HEALTH_TTL_MS = 30_000;

/**
 * `/v1/health` is deliberately public, matching the prediction-gateway convention: an
 * orchestrator's probe should not need a credential. Unauthenticated callers get `{status}`
 * only; the vault detail (mode, initialised, Turnkey reachable) goes to a caller presenting the
 * API key. That detail is a cached lookup, so neither a probe nor a flood of anonymous requests
 * can drive a Turnkey call per hit.
 */
@ApiTags("health")
@Controller("health")
export class HealthController {
  private readonly expectedKey: Buffer;
  private cached: { at: number; value: Promise<VaultHealth> } | undefined;

  constructor(
    private readonly vault: TurnkeyKeyVault,
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) config: Config,
  ) {
    this.expectedKey = Buffer.from(config.apiKey);
  }

  @Public()
  @Get()
  async check(@Req() req: Request): Promise<{ status: string; vault?: VaultHealth }> {
    if (!this.isAuthenticated(req)) return { status: "ok" };
    return { status: "ok", vault: await this.vaultHealth() };
  }

  private vaultHealth(): Promise<VaultHealth> {
    const now = Date.now();
    if (!this.cached || now - this.cached.at >= VAULT_HEALTH_TTL_MS) {
      const value = this.vault.health();
      this.cached = { at: now, value };
      // A failed lookup must not be served for 30 seconds.
      value.catch(() => {
        if (this.cached?.value === value) this.cached = undefined;
      });
    }
    return this.cached.value;
  }

  private isAuthenticated(req: Request): boolean {
    const presented = req.header(API_KEY_HEADER);
    if (!presented) return false;
    const given = Buffer.from(presented);
    return given.length === this.expectedKey.length && timingSafeEqual(given, this.expectedKey);
  }

  /**
   * Readiness: can this process reach its database. `/v1/health` above reports vault health and
   * stays as it is; this is the probe the compose healthcheck uses. The 503 body is `{status}`
   * rather than the error envelope, since a probe reads only the status code.
   */
  @Public()
  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response): Promise<{ status: string }> {
    try {
      await withTimeout(this.db.query("SELECT 1"), READY_TIMEOUT_MS);
      return { status: "ok" };
    } catch {
      res.status(503);
      return { status: "unavailable" };
    }
  }
}
