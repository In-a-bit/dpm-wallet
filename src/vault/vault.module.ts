import { Global, Module } from "@nestjs/common";

import { DpmApiClient } from "../clients/dpm-api.client";
import type { Config } from "../config";
import { TurnkeyDpmSdkFactory } from "../sdk/turnkey-dpm-sdk-factory";
import { CONFIG, DPM_API, KEY_VAULT, SIGNER_PROVIDER, SIGNING_SDK } from "../tokens";
import { VaultController } from "./vault.controller";
import { VaultService } from "./vault.service";
import { TurnkeyKeyVault } from "./turnkey-vault";
import type { SignerProvider } from "./providers/signer-provider.interface";
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
    // One instance for the process, so the Turnkey client and the contract addresses it reads
    // are built once rather than per signing request.
    {
      provide: SIGNING_SDK,
      useFactory: (provider: SignerProvider, config: Config) =>
        new TurnkeyDpmSdkFactory(provider, config),
      inject: [SIGNER_PROVIDER, CONFIG],
    },
    VaultService,
  ],
  exports: [KEY_VAULT, TurnkeyKeyVault, VaultService, SIGNER_PROVIDER, SIGNING_SDK, DPM_API],
})
export class VaultModule {}
