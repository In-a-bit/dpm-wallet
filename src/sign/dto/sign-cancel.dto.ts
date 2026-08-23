import { IsString, MinLength } from "class-validator";

import { IsOrderHash, IsRef, Trimmed } from "../../common/validation/decorators";

export class SignCancelDto {
  @IsRef()
  ref!: string;

  @IsOrderHash()
  orderHash!: string;

  @Trimmed()
  @IsString()
  @MinLength(1)
  marketId!: string;
}
