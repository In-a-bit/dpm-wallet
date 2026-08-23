import { Module } from "@nestjs/common";

import { AddressesModule } from "../addresses/addresses.module";
import { TreasuryController } from "./treasury.controller";
import { TreasuryPolicy } from "./treasury.policy";
import { TreasuryService } from "./treasury.service";

@Module({
  imports: [AddressesModule],
  controllers: [TreasuryController],
  providers: [TreasuryService, TreasuryPolicy],
})
export class TreasuryModule {}
