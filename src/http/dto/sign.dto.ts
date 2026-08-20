import { z } from "zod";

import { addressSchema, refSchema } from "./common.dto.js";

const BUY = 0;
const SELL = 1;

/**
 * `ref` selects the signing key and becomes the order's `signer`. `maker` and `recipient`
 * are the operator's to decide and are signed as supplied — neither is validated against the
 * address directory, and no balance is consulted.
 */
export const signOrderSchema = z.object({
  ref: refSchema,
  maker: addressSchema,
  side: z.union([z.literal(BUY), z.literal(SELL)]),
  tokenId: z.string().trim().regex(/^\d+$/, "must be a decimal CTF token id"),
  shares: z.number().positive(),
  price: z.number().positive().max(1),
  feeRateBps: z.number().int().min(0).max(10_000),
  /** Omit (or pass the zero address) to have the exchange pay the maker. */
  recipient: addressSchema.optional(),
});

export const signCancelSchema = z.object({
  ref: refSchema,
  orderHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex order hash"),
  marketId: z.string().trim().min(1),
});

export type SignOrderBody = z.infer<typeof signOrderSchema>;
export type SignCancelBody = z.infer<typeof signCancelSchema>;
