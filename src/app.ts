import express, { type Express } from "express";

import { apiKeyAuth } from "./http/middleware/api-key.js";
import { errorHandler, notFoundHandler } from "./http/middleware/error-handler.js";
import { idempotency } from "./http/middleware/idempotency.js";
import { requireVaultInitialized } from "./http/middleware/require-vault.js";
import { addressRoutes } from "./http/routes/address.routes.js";
import { auditRoutes } from "./http/routes/audit.routes.js";
import { metaTxRoutes } from "./http/routes/meta-tx.routes.js";
import { signRoutes } from "./http/routes/sign.routes.js";
import { treasuryRoutes } from "./http/routes/treasury.routes.js";
import { healthRoutes, vaultRoutes } from "./http/routes/vault.routes.js";
import type { Runtime } from "./runtime.js";

const BASE_PATH = "/v1";

/** Signed payloads are small; a tight cap keeps an oversized body from reaching zod at all. */
const MAX_BODY_SIZE = "64kb";

/**
 * Route wiring, top-down: health is public, vault init needs only the API key, and everything
 * that touches a key additionally needs an initialised vault.
 */
export function createApp(runtime: Runtime): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: MAX_BODY_SIZE }));

  app.use(BASE_PATH, healthRoutes(runtime));

  const authenticated = express.Router();
  authenticated.use(apiKeyAuth(runtime.config.apiKey));
  authenticated.use(idempotency(runtime.idempotency));
  // Order is the exemption mechanism: vault init and status resolve here, before the guard
  // below joins the chain. Anything mounted after it requires an initialised vault.
  authenticated.use(vaultRoutes(runtime));
  authenticated.use(requireVaultInitialized(runtime.vault));
  authenticated.use(addressRoutes(runtime));
  authenticated.use(signRoutes(runtime));
  authenticated.use(metaTxRoutes(runtime));
  authenticated.use(treasuryRoutes(runtime));
  authenticated.use(auditRoutes(runtime));
  app.use(BASE_PATH, authenticated);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
