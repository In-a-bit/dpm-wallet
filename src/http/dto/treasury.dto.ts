import { z } from "zod";

import { addressSchema, bigintStringSchema, decimalAmountSchema, refSchema } from "./common.dto.js";

/**
 * There is no RPC provider in this service, so the nonce and fee ceilings cannot be read
 * here. The operator, who does have a node, supplies them.
 */
const chainParamsSchema = z.object({
  nonce: z.number().int().min(0),
  gasLimit: bigintStringSchema,
  maxFeePerGas: bigintStringSchema,
  maxPriorityFeePerGas: bigintStringSchema,
});

const amountSchema = z.object({
  amountDecimal: decimalAmountSchema,
  chain: chainParamsSchema,
});

const assetSchema = z.enum(["usdc", "native"]).default("usdc");

/**
 * Only the far end of each movement is named, because the near end is fixed: funding and
 * external withdrawal are always drawn from the master, and a sweep always lands on it.
 * There is deliberately no way to spell "master pays a managed EOA".
 */
export const fundProxySchema = amountSchema.extend({ to: refSchema });

/** No asset: a proxy has no payable fallback, so only USDC can reach one. */
export type FundProxyBody = z.infer<typeof fundProxySchema>;

export const externalWithdrawSchema = amountSchema.extend({
  destination: addressSchema,
  asset: assetSchema,
});

export type ExternalWithdrawBody = z.infer<typeof externalWithdrawSchema>;

export const sweepSchema = amountSchema.extend({
  from: refSchema,
  asset: assetSchema,
});

export type SweepBody = z.infer<typeof sweepSchema>;
