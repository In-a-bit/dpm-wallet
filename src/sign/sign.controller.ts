import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Address } from "viem";

import { AddressesService } from "../addresses/addresses.service";
import { VaultInitializedGuard } from "../common/guards/vault-initialized.guard";
import { SignCancelDto } from "./dto/sign-cancel.dto";
import { SignOrderDto } from "./dto/sign-order.dto";
import { OrderSignerService, type SignedCancel, type SignedOrder } from "./order-signer.service";

@ApiTags("sign")
@UseGuards(VaultInitializedGuard)
@Controller("sign")
export class SignController {
  constructor(
    private readonly addresses: AddressesService,
    private readonly orders: OrderSignerService,
  ) {}

  @Post("order")
  @HttpCode(HttpStatus.OK)
  signOrder(@Body() body: SignOrderDto): Promise<SignedOrder> {
    const { ref, maker, recipient, ...request } = body;
    return this.orders.signOrder(this.addresses.get(ref), {
      ...request,
      maker: maker as Address,
      ...(recipient === undefined ? {} : { recipient: recipient as Address }),
    });
  }

  @Post("cancel")
  @HttpCode(HttpStatus.OK)
  signCancel(@Body() body: SignCancelDto): Promise<SignedCancel> {
    return this.orders.signCancel(this.addresses.get(body.ref), body.orderHash, body.marketId);
  }
}
