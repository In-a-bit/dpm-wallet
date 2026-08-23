import { Module } from "@nestjs/common";

import { AddressesModule } from "../addresses/addresses.module";
import { MetaTxController } from "./meta-tx.controller";
import { MetaTxService } from "./meta-tx.service";

@Module({
  imports: [AddressesModule],
  controllers: [MetaTxController],
  providers: [MetaTxService],
})
export class MetaTxModule {}
