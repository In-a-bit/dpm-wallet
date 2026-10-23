import { Module } from "@nestjs/common";

import { DataApiClient } from "../clients/data-api.client";
import type { Config } from "../config";
import { CONFIG, DATA_API } from "../tokens";
import { BalancesController } from "./balances.controller";

@Module({
  controllers: [BalancesController],
  providers: [
    // Local, like the gamma-api client: only this module reaches data-api with the credential.
    {
      provide: DATA_API,
      useFactory: (config: Config) => new DataApiClient(config.dataApi, config.dpmApi),
      inject: [CONFIG],
    },
  ],
})
export class BalancesModule {}
