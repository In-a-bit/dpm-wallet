import { Global, Module } from "@nestjs/common";

import { DpmApiClient } from "../clients/dpm-api.client";
import type { Config } from "../config";
import { CONFIG, DPM_API, KEY_VAULT, SIGNER_PROVIDER } from "../tokens";
import { VaultController } from "./vault.controller";
import { VaultService } from "./vault.service";
import { TurnkeyKeyVault } from "./turnkey-vault";
import { TurnkeySignerProvider } from "./providers/turnkey.provider";

/**
 * Owns the custody seam. Global because every signing feature needs KEY_VAULT, and importing
 * this module from each of them while it also reaches back for their repositories would be a
 * cycle.
 */
@Global()
@Module({
  controllers: [VaultController],
  providers: [
    {
      provide: SIGNER_PROVIDER,
      useFactory: (config: Config) => new TurnkeySignerProvider(config.turnkey),
      inject: [CONFIG],
    },
    {
      provide: DPM_API,
      useFactory: (config: Config) => new DpmApiClient(config.dpmApi),
      inject: [CONFIG],
    },
    TurnkeyKeyVault,
    // An alias rather than a second registration: the vault holds the adopted sub-organisation
    // in memory, so two instances would leave half the app looking at an uninitialised one.
    { provide: KEY_VAULT, useExisting: TurnkeyKeyVault },
    VaultService,
  ],
  exports: [KEY_VAULT, TurnkeyKeyVault, VaultService, SIGNER_PROVIDER, DPM_API],
})
export class VaultModule {}
