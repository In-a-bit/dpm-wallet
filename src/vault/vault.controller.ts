import { Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { VaultService, type VaultStatus } from "./vault.service";

/**
 * Deliberately not behind `VaultInitializedGuard`: these are the two calls that exist to get
 * an uninitialised install into a usable state and to report whether it is there yet.
 */
@ApiTags("vault")
@Controller("vault")
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  @Post("init")
  @HttpCode(HttpStatus.OK)
  initialize(): Promise<VaultStatus> {
    return this.vault.initialize();
  }

  @Get("status")
  status(): VaultStatus {
    return this.vault.status();
  }
}
