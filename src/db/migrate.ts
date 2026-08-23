import { resolve } from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { logInfo } from "../observability/log";
import type { Db } from "./client";

/**
 * Migrations sit next to the compiled module rather than at a path derived from the
 * process's working directory, so `node dist/main` finds them from anywhere.
 */
const MIGRATIONS_FOLDER = resolve(__dirname, "migrations");

/**
 * Idempotent: brings an older volume up to the current schema after an image upgrade.
 *
 * Deliberately not called during boot. Applying a schema change is a deploy step an operator
 * runs and can roll back, not something a restarting container does to the volume on its own —
 * and with more than one replica, concurrent boots would race to apply the same migration.
 */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  logInfo("db.migrated");
}
