import { Type } from "class-transformer";
import { IsDefined, IsIn, IsInt, Min, ValidateNested } from "class-validator";

import {
  IsBigintString,
  IsDecimalAmount,
  IsEvmAddress,
  IsRef,
} from "../../common/validation/decorators";
import type { TreasuryAsset } from "../treasury.service";

const ASSETS: TreasuryAsset[] = ["usdc", "native"];

/**
 * There is no RPC provider in this service, so the nonce and fee ceilings cannot be read
 * here. The operator, who does have a node, supplies them.
 */
export class ChainParamsDto {
  @IsInt()
  @Min(0)
  nonce!: number;

  @IsBigintString()
  gasLimit!: bigint;

  @IsBigintString()
  maxFeePerGas!: bigint;

  @IsBigintString()
  maxPriorityFeePerGas!: bigint;
}

class TreasuryAmountDto {
  @IsDecimalAmount()
  amountDecimal!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => ChainParamsDto)
  chain!: ChainParamsDto;
}

/**
 * Only the far end of each movement is named, because the near end is fixed: funding and
 * external withdrawal are always drawn from the master, and a sweep always lands on it.
 * There is deliberately no way to spell "master pays a managed EOA".
 */

/** No asset: a proxy has no payable fallback, so only USDC can reach one. */
export class FundProxyDto extends TreasuryAmountDto {
  @IsRef()
  to!: string;
}

export class ExternalWithdrawDto extends TreasuryAmountDto {
  @IsEvmAddress()
  destination!: string;

  @IsIn(ASSETS)
  asset: TreasuryAsset = "usdc";
}

export class SweepDto extends TreasuryAmountDto {
  @IsRef()
  from!: string;

  @IsIn(ASSETS)
  asset: TreasuryAsset = "usdc";
}
