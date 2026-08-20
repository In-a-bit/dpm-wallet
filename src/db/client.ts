import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { logInfo } from "../observability/log.js";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** In-memory databases are for tests; a real deployment always points at the volume. */
const IN_MEMORY_PATH = ":memory:";

export function openDatabase(databasePath: string): Db {
  if (databasePath !== IN_MEMORY_PATH) {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const sqlite = new Database(databasePath);
  applyPragmas(sqlite);
  logInfo("db.opened", { databasePath });
  return drizzle(sqlite, { schema });
}

/**
 * Closing runs a final WAL checkpoint, folding the -wal contents back into the main file.
 * Not needed for correctness — SQLite replays the WAL on the next open — but it leaves the
 * volume holding one self-contained file, which makes backup and restore simpler.
 */
export function closeDatabase(db: Db): void {
  db.$client.close();
  logInfo("db.closed");
}

function applyPragmas(sqlite: Database.Database): void {
  sqlite.pragma("journal_mode = WAL");
  // WAL defaults to synchronous=NORMAL, which fsyncs only at checkpoint. Losing a
  // just-created address row means losing track of customer funds, so pay the latency.
  sqlite.pragma("synchronous = FULL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
}
