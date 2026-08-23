import "dotenv/config";

import { loadConfig } from "../config";
import { logError } from "../observability/log";
import { closeDatabase, openDatabase } from "./client";
import { runMigrations } from "./migrate";

/**
 * The migration step, as its own process.
 *
 * `drizzle-kit migrate` covers this during development, but the runtime image drops the dev
 * dependencies, so the container needs a path to the schema that only uses what ships with it.
 * This reads the same `DATABASE_PATH` the service does, so the operator cannot migrate one
 * volume and start against another.
 */
function main(): void {
  const { databasePath } = loadConfig();
  const db = openDatabase(databasePath);
  try {
    runMigrations(db);
  } finally {
    closeDatabase(db);
  }
}

try {
  main();
} catch (err) {
  logError("db.migrate_failed", { err });
  process.exit(1);
}
