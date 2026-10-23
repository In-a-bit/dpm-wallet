import { ArrayMaxSize, ArrayMinSize, IsArray } from "class-validator";

import { IsEvmAddress } from "../common/validation/decorators";

export class BalancesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsEvmAddress({ each: true })
  addresses!: string[];
}
