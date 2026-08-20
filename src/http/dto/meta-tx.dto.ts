import { z } from "zod";

import type { MetaTxKind } from "../../sdk/wiring.js";
import { addressSchema, conditionIdSchema, decimalAmountSchema, refSchema } from "./common.dto.js";

/**
 * The union of arguments the five kinds accept. Each schema below admits only its own subset,
 * so a request carrying the wrong argument for its kind is rejected as a validation error
 * rather than reaching the builder.
 */
export type MetaTxBody = {
  ref: string;
  conditionId?: string;
  amountDecimal?: string;
  recipient?: string;
};

const allowanceSchema = z.object({ ref: refSchema });

const redeemSchema = allowanceSchema.extend({ conditionId: conditionIdSchema });

const splitSchema = redeemSchema.extend({ amountDecimal: decimalAmountSchema });

const withdrawSchema = allowanceSchema.extend({
  recipient: addressSchema,
  amountDecimal: decimalAmountSchema,
});

/** Keyed by kind so the route table can look the right schema up from the kind alone. */
export const META_TX_SCHEMAS: Record<MetaTxKind, z.ZodType<MetaTxBody>> = {
  allowance: allowanceSchema,
  redeem: redeemSchema,
  split: splitSchema,
  merge: splitSchema,
  withdraw: withdrawSchema,
};
