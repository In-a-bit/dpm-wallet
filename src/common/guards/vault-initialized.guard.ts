import { Injectable, type CanActivate } from "@nestjs/common";

import { vaultNotInitialized } from "../../errors";
import { TurnkeyKeyVault } from "../../vault/turnkey-vault";

/**
 * Guards every controller that needs a key. Checked per request rather than at wiring time so
 * the transition from uninitialised to ready happens the moment `POST /v1/vault/init` returns,
 * with no restart.
 *
 * Unlike the Express middleware it replaces, this is opt-in per controller rather than
 * positional: health and the vault controller are exempt by not declaring it, so adding a new
 * controller cannot silently slip past the guard by being registered in the wrong order.
 */
@Injectable()
export class VaultInitializedGuard implements CanActivate {
  constructor(private readonly vault: TurnkeyKeyVault) {}

  canActivate(): boolean {
    if (!this.vault.initializedState) throw vaultNotInitialized();
    return true;
  }
}
