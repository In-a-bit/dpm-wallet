import "dotenv/config";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { AppModule } from "./app.module";
import { BASE_PATH, configureApp } from "./app.setup";
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

function mountApiDocs(app: NestExpressApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("dpm-wallet")
      .setDescription(
        "Operator-hosted address management and signing service for DPM prediction markets",
      )
      .setVersion("1")
      .addApiKey({ type: "apiKey", name: "X-API-Key", in: "header" }, "apiKey")
      .build(),
  );
  SwaggerModule.setup(`${BASE_PATH}/docs`, app, document);
}

bootstrap().catch((err) => {
  // A boot failure must be loud and fatal: a container that cannot rehydrate its vault would
  // otherwise mint a second, unrelated address tree for refs that already have addresses.
  logError("startup.failed", { err });
  process.exit(1);
});
