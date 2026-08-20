import type { Server } from "node:http";

import { closeDatabase } from "../db/client.js";
import { logError, logInfo } from "../observability/log.js";
import type { Runtime } from "../runtime.js";

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

/** Beyond this, an in-flight request is abandoned rather than holding the container open. */
const DRAIN_TIMEOUT_MS = 25_000;

/**
 * Stops accepting connections, lets in-flight signing finish, then closes the database — which
 * runs a final WAL checkpoint and folds the -wal contents back into the main file.
 *
 * Not required for correctness: signing holds no state across requests, and SQLite replays the
 * WAL on the next open. It just leaves the volume holding one self-contained file.
 */
export function installShutdownHandlers(server: Server, runtime: Runtime): void {
  let shuttingDown = false;

  for (const signal of SIGNALS) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logInfo("shutdown.started", { signal });
      void drainAndExit(server, runtime);
    });
  }
}

async function drainAndExit(server: Server, runtime: Runtime): Promise<void> {
  try {
    await closeServer(server);
    closeDatabase(runtime.db);
    logInfo("shutdown.complete");
    process.exit(0);
  } catch (err) {
    logError("shutdown.failed", { err });
    process.exit(1);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      logInfo("shutdown.drain_timeout", { drainTimeoutMs: DRAIN_TIMEOUT_MS });
      server.closeAllConnections();
      resolve();
    }, DRAIN_TIMEOUT_MS);
    timer.unref();

    server.close((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}
