import "dotenv/config";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { mountApiDocs } from "./api-docs";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";
import type { Config } from "./config";
import { logError, logInfo } from "./observability/log";
import { installShutdownHandlers } from "./startup/shutdown";
import { CONFIG } from "./tokens";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  configureApp(app);
  mountApiDocs(app);
  installShutdownHandlers(app);

  const config = app.get<Config>(CONFIG);
  await app.listen(config.port);
  logInfo("listening", { port: config.port, vaultMode: config.vaultMode });
}

bootstrap().catch((err) => {
  // A boot failure must be loud and fatal: a container that cannot rehydrate its vault would
  // otherwise mint a second, unrelated address tree for refs that already have addresses.
  logError("startup.failed", { err });
  process.exit(1);
});
