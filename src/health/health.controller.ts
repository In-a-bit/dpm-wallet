import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { Public } from "../common/decorators/public.decorator";
import type { Db } from "../db/client";
import { DB } from "../tokens";
import { TurnkeyKeyVault } from "../vault/turnkey-vault";
import type { VaultHealth } from "../vault/key-vault.interface";

/**
 * `/v1/health` is deliberately public, matching the prediction-gateway convention: an
 * orchestrator's probe should not need a credential.
 */
@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly vault: TurnkeyKeyVault,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Public()
  @Get()
  async check(): Promise<{ status: string; vault: VaultHealth }> {
    return { status: "ok", vault: await this.vault.health() };
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
      await this.db.query("SELECT 1");
      return { status: "ok" };
    } catch {
      res.status(503);
      return { status: "unavailable" };
    }
  }
}
