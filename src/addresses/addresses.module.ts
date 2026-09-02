import { Module } from "@nestjs/common";

import { GammaApiClient } from "../clients/gamma-api.client";
import type { Config } from "../config";
import { CONFIG, GAMMA_API } from "../tokens";
import { AddressesController } from "./addresses.controller";
import { AddressesService } from "./addresses.service";

@Module({
  controllers: [AddressesController],
  providers: [
    // Local rather than in the global VaultModule: registration is the only thing that talks to
    // gamma-api, and a credential is easier to trace when only one module can reach it.
    {
      provide: GAMMA_API,
      useFactory: (config: Config) => new GammaApiClient(config.gammaApi),
      inject: [CONFIG],
    },
    AddressesService,
  ],
  exports: [AddressesService],
})
export class AddressesModule {}
