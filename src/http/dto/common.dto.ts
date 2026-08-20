import { getAddress, isAddress } from "viem";
import { z } from "zod";

/**
 * Accepts any casing and normalises to a checksummed address, so a handler never has to
 * think about which form the operator sent.
 */
export const addressSchema = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "must be a 20-byte hex address")
  .transform((value) => getAddress(value));

export const refSchema = z.string().trim().min(1).max(128);

/** A USDC-style decimal amount, e.g. "10" or "10.25". Range checks belong to the SDK. */
export const decimalAmountSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,18})?$/, "must be a positive decimal amount");

export const conditionIdSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex condition id");

export const bigintStringSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, "must be a non-negative integer")
  .transform((value) => BigInt(value));

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof paginationSchema>;
