import type { SubOrganizationCreator } from "./clients/dpm-api.client.js";
import type { Config } from "./config.js";
import type { EncryptionKey } from "./crypto/credential-encryption.js";
import type { Db } from "./db/client.js";
import type { IdempotencyRepository } from "./db/repositories/idempotency.repo.js";
import type { VaultStateRepository } from "./db/repositories/vault-state.repo.js";
import type { WalletRepository } from "./db/repositories/wallet.repo.js";
import type { AuditLog } from "./observability/audit.js";
import type { AddressService } from "./services/address.service.js";
import type { MetaTxService } from "./services/meta-tx.service.js";
import type { OrderSignerService } from "./services/order-signer.service.js";
import type { TreasuryService } from "./services/treasury.service.js";
import type { SignerProvider } from "./vault/providers/signer-provider.interface.js";
import type { TurnkeyKeyVault } from "./vault/turnkey-vault.js";

/**
 * Everything the HTTP layer needs, assembled once at boot. Passing this instead of reaching
 * for module-level singletons is what lets a test drive the whole app against an in-memory
 * database and a stub signer provider.
 */
export type Runtime = {
  config: Config;
  db: Db;
  vault: TurnkeyKeyVault;
  /**
   * The custody provider behind the vault. Exposed because first init and the boot path hand
   * it its credentials, which is a lifecycle concern rather than a signing one.
   */
  provider: SignerProvider;
  /** Creates this install's Turnkey sub-organisation on first init. */
  dpmApi: SubOrganizationCreator;
  /** Parsed once at boot, so a malformed key fails the boot instead of the first write. */
  encryptionKey: EncryptionKey;
  wallets: WalletRepository;
  vaultState: VaultStateRepository;
  idempotency: IdempotencyRepository;
  audit: AuditLog;
  /**
   * Runs several repository writes as one unit, so a multi-row operation cannot leave the
   * volume half-written. Synchronous by necessity: better-sqlite3 transactions cannot span
   * an await, so any provider call must complete before the transaction opens.
   */
  transaction: <T>(work: () => T) => T;
  services: {
    addresses: AddressService;
    orders: OrderSignerService;
    metaTx: MetaTxService;
    treasury: TreasuryService;
  };
};
