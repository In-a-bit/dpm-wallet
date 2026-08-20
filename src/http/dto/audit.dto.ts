import { z } from "zod";

import { paginationSchema, refSchema } from "./common.dto.js";

const isoTimestampSchema = z.string().datetime({ offset: true });

/**
 * `from`/`to` are optional filters, not the bound on result size — that comes from
 * `paginationSchema`, which defaults `limit` to 50 and rejects anything above 200. Omitting
 * the range widens what matches, never how much comes back.
 */
export const auditQuerySchema = paginationSchema.extend({
  ref: refSchema.optional(),
  action: z.string().trim().min(1).max(64).optional(),
  from: isoTimestampSchema.optional(),
  to: isoTimestampSchema.optional(),
});

export type AuditQueryParams = z.infer<typeof auditQuerySchema>;
