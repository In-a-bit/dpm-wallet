import "dotenv/config";
import http from "node:http";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logError, logInfo } from "./observability/log.js";
import { bootstrap } from "./startup/bootstrap.js";
import { installShutdownHandlers } from "./startup/shutdown.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = await bootstrap(config);
  const server = http.createServer(createApp(runtime));
  installShutdownHandlers(server, runtime);

  server.listen(config.port, () => {
    logInfo("listening", { port: config.port, vaultMode: config.vaultMode });
  });
}

main().catch((err) => {
  // A boot failure must be loud and fatal: a container that cannot rehydrate its vault would
  // otherwise mint a second, unrelated address tree for refs that already have addresses.
  logError("startup.failed", { err });
  process.exit(1);
});
