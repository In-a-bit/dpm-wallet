import type { Db } from "../db/client";

/** Any table from the first migration will do; this one is written on the very first request. */
const SCHEMA_PROBE_TABLE = "wallets";

/**
 * Migrating happens outside the service — the container's command, or an operator's — so an
 * unmigrated volume is a deployment mistake rather than something to repair here. Saying so at
 * boot beats letting the first request fail on a missing table, which reads as a bug in the
 * service.
 */
export function assertSchemaPresent(db: Db): void {
  const table = db.$client
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(SCHEMA_PROBE_TABLE);
  if (table) return;
  throw new Error(
    'The database has no schema. Run "npm run db:migrate" before starting the service — ' +
      "the image's own command does this, so reaching this means it was overridden.",
  );
}
