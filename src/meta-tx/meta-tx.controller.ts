import type { SubmitTransactionRequest } from "@inabit-com/dpm-sdk/server";
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { AddressesService } from "../addresses/addresses.service";
import { VaultInitializedGuard } from "../common/guards/vault-initialized.guard";
import type { MetaTxKind } from "../sdk/wiring";
import {
  MetaTxAllowanceDto,
  MetaTxRedeemDto,
  MetaTxSplitDto,
  MetaTxWithdrawDto,
} from "./dto/meta-tx.dto";
import { MetaTxService, type MetaTxArgs } from "./meta-tx.service";

/**
 * Each endpoint returns a complete `SubmitTransactionRequest` the operator POSTs verbatim to
 * `relayer-api`. Submission is the operator's step, never this service's.
 */
@ApiTags("meta-tx")
@UseGuards(VaultInitializedGuard)
@Controller("meta-tx")
export class MetaTxController {
  constructor(
    private readonly addresses: AddressesService,
    private readonly metaTx: MetaTxService,
  ) {}

  @Post("allowance")
  @HttpCode(HttpStatus.OK)
  allowance(@Body() body: MetaTxAllowanceDto): Promise<SubmitTransactionRequest> {
    return this.build("allowance", body.ref, {});
  }

  @Post("redeem")
  @HttpCode(HttpStatus.OK)
  redeem(@Body() body: MetaTxRedeemDto): Promise<SubmitTransactionRequest> {
    return this.build("redeem", body.ref, {
      conditionId: body.conditionId,
      recipient: body.recipient,
    });
  }

  @Post("split")
  @HttpCode(HttpStatus.OK)
  split(@Body() body: MetaTxSplitDto): Promise<SubmitTransactionRequest> {
    return this.build("split", body.ref, {
      conditionId: body.conditionId,
      amountDecimal: body.amountDecimal,
    });
  }

  @Post("merge")
  @HttpCode(HttpStatus.OK)
  merge(@Body() body: MetaTxSplitDto): Promise<SubmitTransactionRequest> {
    return this.build("merge", body.ref, {
      conditionId: body.conditionId,
      amountDecimal: body.amountDecimal,
    });
  }

  @Post("withdraw")
  @HttpCode(HttpStatus.OK)
  withdraw(@Body() body: MetaTxWithdrawDto): Promise<SubmitTransactionRequest> {
    return this.build("withdraw", body.ref, {
      recipient: body.recipient,
      amountDecimal: body.amountDecimal,
    });
  }

  private async build(
    kind: MetaTxKind,
    ref: string,
    args: MetaTxArgs,
  ): Promise<SubmitTransactionRequest> {
    return this.metaTx.build(kind, await this.addresses.get(ref), args);
  }
}
