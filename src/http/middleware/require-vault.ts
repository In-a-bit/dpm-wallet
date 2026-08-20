import type { RequestHandler } from "express";

import { vaultNotInitialized } from "../../errors.js";
import type { TurnkeyKeyVault } from "../../vault/turnkey-vault.js";

/**
 * Guards every route that needs a key. Checked per request rather than at wiring time so the
 * transition from uninitialised to ready happens the moment `POST /v1/vault/init` returns,
 * with no restart.
 *
 * Nothing is excluded by path. Express runs middleware in registration order and stops at the
 * first route that matches, so health and the vault routes are exempt purely by being mounted
 * ahead of this in `createApp` — see the ordering there. The consequence worth knowing: a route
 * added *above* this line is silently unguarded.
 */
export function requireVaultInitialized(vault: TurnkeyKeyVault): RequestHandler {
  return (_req, _res, next) => {
    if (!vault.initializedState) {
      next(vaultNotInitialized());
      return;
    }
    next();
  };
}
