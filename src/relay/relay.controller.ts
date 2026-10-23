import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { AddressesService } from "../addresses/addresses.service";
import { RelayerApiClient } from "../clients/relayer-api.client";
import { RELAYER_API } from "../tokens";
import { RelayStatusQueryDto, RelaySubmitDto } from "./relay.dto";

/**
 * Submits signed meta-transactions and reports their state. This service holds the install's
 * only platform credential, so a manager relays through here; and it relays only for EOAs it
 * holds, so that credential cannot be spent acting for someone else's address.
 */
@ApiTags("relay")
@Controller("relay")
export class RelayController {
  constructor(
    private readonly addresses: AddressesService,
    @Inject(RELAYER_API) private readonly relayer: RelayerApiClient,
  ) {}

  @Post()
  async submit(@Body() body: RelaySubmitDto): Promise<Record<string, unknown>> {
    await this.addresses.getByEoaAddress(body.from);
    return this.relayer.submit(body);
  }

  @Get(":id")
  async status(
    @Param("id") id: string,
    @Query() query: RelayStatusQueryDto,
  ): Promise<Record<string, unknown>> {
    await this.addresses.getByEoaAddress(query.from);
    return this.relayer.transaction(id, query.from);
  }
}
