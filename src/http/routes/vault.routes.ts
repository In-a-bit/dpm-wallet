import { Router } from "express";

import type { Runtime } from "../../runtime.js";
import { initializeVault, vaultStatus } from "../../startup/vault-lifecycle.js";

/**
 * `/v1/health` is deliberately mounted outside the API-key gate, matching the
 * prediction-gateway convention: an orchestrator's probe should not need a credential.
 */
export function healthRoutes(runtime: Runtime): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const health = await runtime.vault.health();
    res.json({ status: "ok", vault: health });
  });

  return router;
}

export function vaultRoutes(runtime: Runtime): Router {
  const router = Router();

  router.post("/vault/init", async (_req, res) => {
    res.json(await initializeVault(runtime));
  });

  router.get("/vault/status", (_req, res) => {
    res.json(vaultStatus(runtime));
  });

  return router;
}
