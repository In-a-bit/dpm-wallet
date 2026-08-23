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
 * redeem adds a condition, split adds an amount on top of that.
 */
export class MetaTxAllowanceDto {
  @IsRef()
  ref!: string;
}

export class MetaTxRedeemDto extends MetaTxAllowanceDto {
  @IsConditionId()
  conditionId!: string;
}

/** Split and merge take the same arguments, as they did when both used one schema. */
export class MetaTxSplitDto extends MetaTxRedeemDto {
  @IsDecimalAmount()
  amountDecimal!: string;
}

export class MetaTxWithdrawDto extends MetaTxAllowanceDto {
  @IsEvmAddress()
  recipient!: string;

  @IsDecimalAmount()
  amountDecimal!: string;
}
