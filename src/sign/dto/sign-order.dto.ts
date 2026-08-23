import { IsIn, IsInt, IsNumber, IsOptional, IsPositive, Max, Min } from "class-validator";

import { IsCtfTokenId, IsEvmAddress, IsRef } from "../../common/validation/decorators";

const BUY = 0;
const SELL = 1;

const MAX_FEE_RATE_BPS = 10_000;

/**
 * `ref` selects the signing key and becomes the order's `signer`. `maker` and `recipient`
 * are the operator's to decide and are signed as supplied — neither is validated against the
 * address directory, and no balance is consulted.
 */
export class SignOrderDto {
  @IsRef()
  ref!: string;

  @IsEvmAddress()
  maker!: string;

  /** Strictly the numbers 0 or 1; the string "0" is rejected, as it was under zod. */
  @IsIn([BUY, SELL])
  side!: 0 | 1;

  @IsCtfTokenId()
  tokenId!: string;

  @IsNumber()
  @IsPositive()
  shares!: number;

  @IsNumber()
  @IsPositive()
  @Max(1)
  price!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_FEE_RATE_BPS)
  feeRateBps!: number;

  /** Omit (or pass the zero address) to have the exchange pay the maker. */
  @IsOptional()
  @IsEvmAddress()
  recipient?: string;
}
