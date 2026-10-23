import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import type { CollateralBalance } from "../clients/data-api.client";
import { DataApiClient } from "../clients/data-api.client";
import { DATA_API } from "../tokens";
import { BalancesDto } from "./balances.dto";

/** Collateral balances for addresses of this install, read from data-api. */
@ApiTags("balances")
@Controller("balances")
export class BalancesController {
  constructor(@Inject(DATA_API) private readonly dataApi: DataApiClient) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  balances(@Body() body: BalancesDto): Promise<CollateralBalance[]> {
    return this.dataApi.batchBalances(body.addresses);
  }
}
