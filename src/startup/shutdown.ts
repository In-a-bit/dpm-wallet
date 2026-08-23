import type { Server } from "node:http";

import type { INestApplication } from "@nestjs/common";

import { logError, logInfo } from "../observability/log";

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

/** Beyond this, an in-flight request is abandoned rather than holding the container open. */
const DRAIN_TIMEOUT_MS = 25_000;

/**
 * Stops accepting connections, lets in-flight signing finish, then closes the app — which runs
 * the shutdown hooks, and with them the final WAL checkpoint that folds the -wal contents back
 * into the main database file.
 *
 * Not required for correctness: signing holds no state across requests, and SQLite replays the
 * WAL on the next open. It just leaves the volume holding one self-contained file.
 *
 * Nest's own `enableShutdownHooks` is deliberately not used: it closes the server immediately
 * on a signal, with no drain window for a signature already in flight.
 */
export function installShutdownHandlers(app: INestApplication): void {
  let shuttingDown = false;

  for (const signal of SIGNALS) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logInfo("shutdown.started", { signal });
      void drainAndExit(app);
    });
  }
}

async function drainAndExit(app: INestApplication): Promise<void> {
  try {
    await closeServer(app.getHttpServer() as Server);
    await app.close();
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
