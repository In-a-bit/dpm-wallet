import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../common/decorators/public.decorator";
import { TurnkeyKeyVault } from "../vault/turnkey-vault";
import type { VaultHealth } from "../vault/key-vault.interface";

/**
 * `/v1/health` is deliberately public, matching the prediction-gateway convention: an
 * orchestrator's probe should not need a credential.
 */
@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly vault: TurnkeyKeyVault) {}

  @Public()
  @Get()
  async check(): Promise<{ status: string; vault: VaultHealth }> {
    return { status: "ok", vault: await this.vault.health() };
  }
}
