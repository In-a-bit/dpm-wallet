import { Module } from "@nestjs/common";

import { AddressesModule } from "../addresses/addresses.module";
import { OrderSignerService } from "./order-signer.service";
import { SignController } from "./sign.controller";

@Module({
  imports: [AddressesModule],
  controllers: [SignController],
  providers: [OrderSignerService],
})
export class SignModule {}
