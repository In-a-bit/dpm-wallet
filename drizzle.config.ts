import "dotenv/config";

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { defineConfig } from "drizzle-kit";

/**
 * The service applies migrations itself at boot, so drizzle-kit is only used to author
 * them (`npm run db:generate`) and to inspect a volume by hand (`db:migrate`, `db:check`,
 * `db:studio`). Those inspection commands need a file, and the container path is not
 * reachable from a workstation, hence the local default.
 */
const databasePath = process.env.DRIZZLE_DATABASE_PATH ?? "./data/dpm-wallet.sqlite";

// better-sqlite3 creates the file but not its parent directory, and `data/` is gitignored,
// so a fresh checkout would otherwise fail on the first `db:migrate` or `db:studio`.
mkdirSync(dirname(databasePath), { recursive: true });

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: databasePath,
  },
});
