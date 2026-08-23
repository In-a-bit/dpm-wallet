import type { NestExpressApplication } from "@nestjs/platform-express";

export const BASE_PATH = "v1";

/** Signed payloads are small; a tight cap keeps an oversized body from reaching validation at all. */
const MAX_BODY_SIZE = "64kb";

/**
 * Everything the app needs beyond its module graph. Shared with the end-to-end tests so they
 * exercise the same prefix, body cap and header behaviour the container runs with.
 *
 * The app must be created with `bodyParser: false`; registering a second JSON parser on top of
 * Nest's default would leave the default's 100kb limit in force and silently widen the cap.
 */
export function configureApp(app: NestExpressApplication): void {
  app.getHttpAdapter().getInstance().disable("x-powered-by");
  app.useBodyParser("json", { limit: MAX_BODY_SIZE });
  app.setGlobalPrefix(BASE_PATH);
}
