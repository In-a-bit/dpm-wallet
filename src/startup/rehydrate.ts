import { getAddress } from "viem";

import { decryptCredential } from "../crypto/credential-encryption.js";
import type { VaultStateRecord } from "../db/repositories/vault-state.repo.js";
import { DpmwError } from "../errors.js";
import { logInfo, logWarn } from "../observability/log.js";
import type { Runtime } from "../runtime.js";
import type { MasterInfo } from "../vault/key-vault.interface.js";
import type { ProviderCredentials } from "../vault/providers/signer-provider.interface.js";

/**
 * Restores the vault from the volume: the sub-organisation credentials the container needs
 * to reach Turnkey at all, then the vault handle, then a check that the volume and the
 * sub-organisation still agree on which addresses exist.
 *
 * A divergence means the database came from a different install, or the container is pointed at
 * a different Turnkey sub-organisation. Continuing would silently mint a second, unrelated
 * address tree for refs that already have addresses — so this check aborts the boot rather than
 * surfacing as an HTTP error, and the server never binds.
 */
export async function rehydrateVault(runtime: Runtime): Promise<void> {
  const state = runtime.vaultState.load();
  if (!state?.initialized) {
    // Also the interrupted-init case, where a key pair is reserved but no sub-organisation
    // exists yet: POST /v1/vault/init resumes it, and until then the provider stays
    // credential-less and every signing route reports 409.
    logInfo("startup.vault_uninitialized");
    return;
  }

  const { credentials, master } = readInitializedState(runtime, state);
  runtime.provider.adoptCredentials(credentials);
  runtime.vault.adopt({
    subOrgId: credentials.subOrgId,
    walletId: credentials.walletId,
    master,
  });
  await assertVaultMatchesDbAddresses(runtime);
  logInfo("startup.vault_rehydrated", {
    subOrgName: state.subOrgName,
    masterAddress: master.address,
  });
}

/**
 * Recovers what an initialised install acts with. A row marked initialised is expected to
 * carry all of it; a gap means the row was written by an incompatible build, and a boot that
 * continued would fail every request with a confusing Turnkey error instead of naming the
 * volume as the problem.
 */
function readInitializedState(
  runtime: Runtime,
  state: VaultStateRecord,
): { credentials: ProviderCredentials; master: MasterInfo } {
  if (!state.subOrgId || !state.turnkeyWalletId || !state.masterAddress) {
    throw new DpmwError(
      "INTERNAL_ERROR",
      "VAULT_DB_MISMATCH: the vault state row is initialised but holds no sub-organization",
    );
  }
  return {
    credentials: {
      subOrgId: state.subOrgId,
      walletId: state.turnkeyWalletId,
      apiPublicKey: state.subOrgApiPublicKey,
      apiPrivateKey: decryptCredential(runtime.encryptionKey, state.subOrgApiPrivateKeyEncrypted),
    },
    master: {
      address: getAddress(state.masterAddress),
      index: 0,
      createdAt: state.createdAt,
    },
  };
}

/**
 * Reconciles the custody organisation against the directory in both directions, because the
 * two mismatches are different faults.
 *
 * An address the database issued but the vault does not hold is fatal: the operator has been
 * handed that address and may have funded it, and no key exists to sign for it.
 *
 * An address the vault holds but the database does not is reported and tolerated. It is the
 * expected residue of a crash between `createAccount` returning and the row being inserted,
 * which leaves a derived account with no directory entry — recoverable, since account
 * creation is idempotent per derivation path and the next create simply re-derives it.
 * Failing the boot on it would let one badly-timed crash brick the service permanently.
 */
async function assertVaultMatchesDbAddresses(runtime: Runtime): Promise<void> {
  const managedAddressesFromDb = runtime.wallets.allEoaAddresses();
  const heldByVault = new Set((await runtime.vault.listAddresses()).map(lower));

  const untracked = [...heldByVault].filter(
    (address) => !managedAddressesFromDb.some((known) => lower(known) === address),
  );
  if (untracked.length > 0) {
    logWarn("startup.vault_addresses_untracked", {
      count: untracked.length,
      firstAddress: untracked[0],
    });
  }

  const missing = managedAddressesFromDb.filter((address) => !heldByVault.has(lower(address)));
  if (missing.length === 0) return;

  throw new DpmwError(
    "INTERNAL_ERROR",
    `VAULT_DB_MISMATCH: ${missing.length} directory address(es) are absent from the ` +
      `custody organisation, starting with ${missing[0]}. The volume and Turnkey have diverged.`,
  );
}

function lower(address: string): string {
  return address.toLowerCase();
}
