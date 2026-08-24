import { IsOptional } from "class-validator";

import {
  IsConditionId,
  IsDecimalAmount,
  IsEvmAddress,
  IsRef,
} from "../../common/validation/decorators";

/**
 * The five kinds admit different arguments, and each class below admits only its own subset,
 * so a request carrying the wrong argument for its kind is stripped or rejected as a
 * validation error rather than reaching the builder.
 *
 * The inheritance chain mirrors how these were layered as zod schemas: allowance is the base,
 * and a condition is added on top of it. Redeem and split then diverge, because only redeem
 * takes a recipient — were split to inherit it, a request naming one would be accepted and
 * then silently ignored by the builder.
 */
export class MetaTxAllowanceDto {
  @IsRef()
  ref!: string;
}

/** The arguments shared by every kind that names a position. */
export class MetaTxConditionDto extends MetaTxAllowanceDto {
  @IsConditionId()
  conditionId!: string;
}

export class MetaTxRedeemDto extends MetaTxConditionDto {
  /**
   * Omit to leave the redeemed collateral in the proxy wallet. When set, the SDK quotes the
   * payout from the relayer and forwards exactly that much in the same proxy transaction, so
   * a redemption that pays less reverts the whole batch rather than transferring short.
   */
  @IsOptional()
  @IsEvmAddress()
  recipient?: string;
}

/** Split and merge take the same arguments, as they did when both used one schema. */
export class MetaTxSplitDto extends MetaTxConditionDto {
  @IsDecimalAmount()
  amountDecimal!: string;
}

export class MetaTxWithdrawDto extends MetaTxAllowanceDto {
  @IsEvmAddress()
  recipient!: string;

  @IsDecimalAmount()
  amountDecimal!: string;
}
