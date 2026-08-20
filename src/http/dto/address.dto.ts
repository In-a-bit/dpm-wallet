import { z } from "zod";

import { paginationSchema, refSchema } from "./common.dto.js";

/**
 * There is no `role` field: every address this endpoint creates is a user wallet at the next
 * free index. An operator wallet backing the operator's shared balance is created here like any
 * other, under a ref of the operator's choosing.
 */
export const createAddressSchema = z.object({
  ref: refSchema,
});

export const listAddressesSchema = paginationSchema;

export const dpmRegisteredSchema = z.object({
  registered: z.boolean().default(true),
});

export type CreateAddressRequest = z.infer<typeof createAddressSchema>;
export type DpmRegisteredRequest = z.infer<typeof dpmRegisteredSchema>;
