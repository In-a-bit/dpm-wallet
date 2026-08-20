import { generateApiKeyPair } from "../crypto/api-key-pair.js";
import { decryptCredential, encryptCredential } from "../crypto/credential-encryption.js";
import type { VaultStateRecord } from "../db/repositories/vault-state.repo.js";
import { MASTER_DERIVATION_INDEX, MASTER_REF } from "../db/repositories/wallet.repo.js";
import { AuditAction } from "../observability/audit-action.js";
import { logInfo } from "../observability/log.js";
import type { Runtime } from "../runtime.js";
import { derivationPath, type MasterInfo } from "../vault/key-vault.interface.js";
import type { ProviderCredentials } from "../vault/providers/signer-provider.interface.js";

export type VaultStatus = {
  mode: string;
  initialized: boolean;
  master?: MasterInfo;
};

/**
 * First-run initialisation, in the order the failure modes demand:
 *
 * 1. mint the API key pair and write it to the volume,
 * 2. ask dpm-api for a Turnkey sub-organisation governed by that key pair,
 * 3. adopt what came back, so the provider and the vault can act,
 * 4. record all of it in one transaction that marks the vault initialised.
 *
 * The key pair is persisted first because creating a sub-organisation is a remote side
 * effect that cannot be undone. dpm-api recognises a retry by the public key it receives,
 * so an attempt that dies anywhere after step 1 resumes with the *same* key pair and is
 * handed the sub-organisation it already owns. Generating a fresh pair instead would be
 * refused as a second sub-organisation for the same owner, leaving the install unable to
 * initialise at all.
 *
 * Nothing here talks to Turnkey. The sub-org, its HD wallet and the master account at index
 * 0 are all created in the single activity dpm-api runs, so their identifiers arrive in its
 * response and this function only has to persist them.
 *
 * Idempotent by short-circuit rather than by upsert: once the state row says initialised
 * this returns what is already there and writes nothing.
 */
export async function initializeVault(runtime: Runtime): Promise<VaultStatus> {
  const existing = runtime.vaultState.load();
  if (existing?.initialized) return vaultStatus(runtime);

  const state = reserveApiKeyPair(runtime, existing);
  const apiKeyPair = readApiKeyPair(runtime, state);
  const subOrg = await runtime.dpmApi.createSubOrganization({
    apiPublicKey: apiKeyPair.apiPublicKey,
    walletName: runtime.config.turnkey.walletName,
    masterDerivationPath: derivationPath(MASTER_DERIVATION_INDEX),
  });

  // Dated from the state row rather than the clock, so an install reports the same master
  // creation time before and after a restart.
  const master: MasterInfo = {
    address: subOrg.masterAddress,
    index: MASTER_DERIVATION_INDEX,
    createdAt: state.createdAt,
  };
  runtime.provider.adoptCredentials({
    subOrgId: subOrg.subOrgId,
    walletId: subOrg.walletId,
    ...apiKeyPair,
  });
  runtime.vault.adopt({ subOrgId: subOrg.subOrgId, walletId: subOrg.walletId, master });

  // One transaction over all three writes. A failure partway through — a unique-index
  // collision on the master row, say — would otherwise leave the vault marked initialised
  // with no master in the directory, a state no later call can repair because the row
  // makes its one transition here.
  runtime.transaction(() => {
    runtime.vaultState.complete({
      subOrgId: subOrg.subOrgId,
      subOrgName: subOrg.subOrgName,
      turnkeyWalletId: subOrg.walletId,
      masterAddress: master.address,
    });
    runtime.services.addresses.recordMaster(MASTER_REF, master.address);
    runtime.audit.record({
      ref: MASTER_REF,
      action: AuditAction.VaultInit,
      outcome: "success",
      detail: { address: master.address, index: master.index, subOrgId: subOrg.subOrgId },
    });
  });

  logInfo("vault.initialized", {
    subOrgName: subOrg.subOrgName,
    masterAddress: master.address,
  });
  return { mode: runtime.vault.mode, initialized: true, master };
}

/**
 * Returns the state row this init runs against: the one an interrupted attempt already left
 * on the volume, or a new one holding a freshly minted key pair, written before anything
 * leaves the process.
 */
function reserveApiKeyPair(
  runtime: Runtime,
  existing: VaultStateRecord | undefined,
): VaultStateRecord {
  if (existing) {
    logInfo("vault.api_key_pair_resumed", { apiPublicKey: existing.subOrgApiPublicKey });
    return existing;
  }

  const generated = generateApiKeyPair();
  const reserved = runtime.vaultState.reserve(
    {
      mode: runtime.vault.mode,
      subOrgApiPublicKey: generated.publicKeyHex,
      subOrgApiPrivateKeyEncrypted: encryptCredential(
        runtime.encryptionKey,
        generated.privateKeyHex,
      ),
    },
    new Date().toISOString(),
  );
  // A concurrent init may have won the insert, in which case its key pair is the one on the
  // volume and the one dpm-api will recognise; the pair generated here is discarded.
  const won = reserved.subOrgApiPublicKey === generated.publicKeyHex;
  logInfo(won ? "vault.api_key_pair_reserved" : "vault.api_key_pair_resumed", {
    apiPublicKey: reserved.subOrgApiPublicKey,
  });
  return reserved;
}

function readApiKeyPair(
  runtime: Runtime,
  state: VaultStateRecord,
): Pick<ProviderCredentials, "apiPublicKey" | "apiPrivateKey"> {
  return {
    apiPublicKey: state.subOrgApiPublicKey,
    apiPrivateKey: decryptCredential(runtime.encryptionKey, state.subOrgApiPrivateKeyEncrypted),
  };
}

/**
 * Reports initialised only when both halves are in place: the key in the custody backend and
 * the row on the volume. A vault holding a master that no row records is a failed init that
 * has yet to be retried, and saying otherwise would send the operator away satisfied.
 */
export function vaultStatus(runtime: Runtime): VaultStatus {
  const master = runtime.vault.initializedState?.master;
  const recorded = runtime.vaultState.load()?.initialized === true;
  return {
    mode: runtime.vault.mode,
    initialized: recorded && master !== undefined,
    ...(master ? { master } : {}),
  };
}
