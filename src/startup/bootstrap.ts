import { DpmApiClient, type SubOrganizationCreator } from "../clients/dpm-api.client.js";
import type { Config } from "../config.js";
import { parseEncryptionKey } from "../crypto/credential-encryption.js";
import { closeDatabase, openDatabase, type Db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { AuditRepository } from "../db/repositories/audit.repo.js";
import { IdempotencyRepository } from "../db/repositories/idempotency.repo.js";
import { VaultStateRepository } from "../db/repositories/vault-state.repo.js";
import { WalletRepository } from "../db/repositories/wallet.repo.js";
import { AuditLog } from "../observability/audit.js";
import { logInfo, setLogLevel } from "../observability/log.js";
import type { Runtime } from "../runtime.js";
import { AddressService } from "../services/address.service.js";
import { MetaTxService } from "../services/meta-tx.service.js";
import { OrderSignerService } from "../services/order-signer.service.js";
import { TreasuryPolicy } from "../services/policy.js";
import { TreasuryService } from "../services/treasury.service.js";
import { TurnkeyKeyVault } from "../vault/turnkey-vault.js";
import type { SignerProvider } from "../vault/providers/signer-provider.interface.js";
import { TurnkeySignerProvider } from "../vault/providers/turnkey.provider.js";
import { rehydrateVault } from "./rehydrate.js";
import { assertExchangeDomain } from "./self-check.js";

/** Idempotency records older than this are purged at boot; the retry window is much shorter. */
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * The collaborators a test replaces: the custody backend and the control-plane API. Both
 * default to the real thing, so production wiring is `bootstrap(config)`.
 */
export type BootstrapDeps = {
  provider?: SignerProvider;
  dpmApi?: SubOrganizationCreator;
};

/**
 * Rebuilds the entire working state from the volume before the HTTP server binds. Nothing is
 * held only in memory between runs, and no step needs the operator to re-supply anything
 * beyond the environment variables — the sub-organisation credentials come off the volume,
 * where only their encrypted half is stored.
 */
export async function bootstrap(config: Config, deps: BootstrapDeps = {}): Promise<Runtime> {
  setLogLevel(config.logLevel);
  assertExchangeDomain();

  const provider = deps.provider ?? new TurnkeySignerProvider(config.turnkey);
  const dpmApi = deps.dpmApi ?? new DpmApiClient(config.dpmApi);
  const db = openDatabase(config.databasePath);
  try {
    runMigrations(db);
    const runtime = assembleRuntime(config, db, provider, dpmApi);
    await rehydrateVault(runtime);
    purgeExpiredIdempotencyKeys(runtime);
    return runtime;
  } catch (err) {
    // A half-open database would leave a stale -wal behind and hold the volume's write lock.
    closeDatabase(db);
    throw err;
  }
}

function assembleRuntime(
  config: Config,
  db: Db,
  provider: SignerProvider,
  dpmApi: SubOrganizationCreator,
): Runtime {
  const wallets = new WalletRepository(db);
  const audit = new AuditLog(new AuditRepository(db));
  const vault = new TurnkeyKeyVault(provider);
  const policy = new TreasuryPolicy(wallets);

  return {
    config,
    db,
    vault,
    provider,
    dpmApi,
    encryptionKey: parseEncryptionKey(config.encryptionKey),
    wallets,
    vaultState: new VaultStateRepository(db),
    idempotency: new IdempotencyRepository(db),
    audit,
    transaction: (work) => db.$client.transaction(work)(),
    services: {
      addresses: new AddressService(wallets, vault, config, audit),
      orders: new OrderSignerService(vault, config, audit),
      metaTx: new MetaTxService(vault, config, audit),
      treasury: new TreasuryService(vault, config, wallets, policy, audit),
    },
  };
}

function purgeExpiredIdempotencyKeys(runtime: Runtime): void {
  const cutoff = new Date(Date.now() - IDEMPOTENCY_RETENTION_MS).toISOString();
  const purged = runtime.idempotency.purgeOlderThan(cutoff);
  if (purged > 0) logInfo("startup.idempotency_purged", { purged });
}
