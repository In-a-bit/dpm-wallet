import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { logInfo } from "../observability/log.js";
import type { Db } from "./client.js";

/**
 * Migrations sit next to the compiled module rather than at a path derived from the
 * process's working directory, so `node dist/index.js` finds them from anywhere.
 */
const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Idempotent: brings an older volume up to the current schema after an image upgrade. */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  logInfo("db.migrated");
}
