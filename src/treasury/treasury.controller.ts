import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Address } from "viem";

import { AddressesService } from "../addresses/addresses.service";
import { VaultInitializedGuard } from "../common/guards/vault-initialized.guard";
import { ExternalWithdrawDto, FundProxyDto, SweepDto } from "./dto/treasury.dto";
import { TreasuryService, type SignedTransaction } from "./treasury.service";

/**
 * The three raw-transaction movements the treasury allows. A user's tradable balance moves
 * out of their proxy through `POST /v1/meta-tx/withdraw` instead, because only the RelayHub
 * can spend from a proxy.
 */
@ApiTags("treasury")
@UseGuards(VaultInitializedGuard)
@Controller("treasury")
export class TreasuryController {
  constructor(
    private readonly addresses: AddressesService,
    private readonly treasury: TreasuryService,
  ) {}

  @Post("fund-proxy")
  @HttpCode(HttpStatus.OK)
  fundProxy(@Body() body: FundProxyDto): Promise<SignedTransaction> {
    const { to, ...amount } = body;
    return this.treasury.fundProxy(this.addresses.get(to), amount);
  }

  @Post("external-withdraw")
  @HttpCode(HttpStatus.OK)
  externalWithdraw(@Body() body: ExternalWithdrawDto): Promise<SignedTransaction> {
    const { destination, ...transfer } = body;
    return this.treasury.externalWithdraw({
      ...transfer,
      destination: destination as Address,
    });
  }

  @Post("sweep")
  @HttpCode(HttpStatus.OK)
  sweep(@Body() body: SweepDto): Promise<SignedTransaction> {
    const { from, ...transfer } = body;
    return this.treasury.sweepToMaster(this.addresses.get(from), transfer);
  }
}
