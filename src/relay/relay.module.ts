import { Module } from "@nestjs/common";

import { AddressesModule } from "../addresses/addresses.module";
import { RelayerApiClient } from "../clients/relayer-api.client";
import type { Config } from "../config";
import { CONFIG, RELAYER_API } from "../tokens";
import { RelayController } from "./relay.controller";

@Module({
  imports: [AddressesModule],
  controllers: [RelayController],
  providers: [
    // Local, like the data-api client: only this module relays with the platform credential.
    {
      provide: RELAYER_API,
      useFactory: (config: Config) => new RelayerApiClient(config.relayer, config.dpmApi),
      inject: [CONFIG],
    },
  ],
})
export class RelayModule {}
