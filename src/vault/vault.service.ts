import { Inject, Injectable } from "@nestjs/common";

import type { SubOrganizationCreator } from "../clients/dpm-api.client";
import type { Config } from "../config";
import { generateApiKeyPair } from "../crypto/api-key-pair";
import {
  decryptCredential,
  encryptCredential,
  type EncryptionKey,
} from "../crypto/credential-encryption";
import { VaultStateRepository, type VaultStateRecord } from "../db/repositories/vault-state.repo";
import { WalletRepository } from "../db/repositories/wallet.repo";
import { DpmwError } from "../errors";
import { AuditAction } from "../observability/audit-action";
import { AuditLog } from "../observability/audit";
import { logInfo, logWarn } from "../observability/log";
import { CONFIG, DPM_API, ENCRYPTION_KEY, SIGNER_PROVIDER, TRANSACTION } from "../tokens";
import type { Transaction } from "../tokens";
import type { ProviderCredentials, SignerProvider } from "./providers/signer-provider.interface";
import { TurnkeyKeyVault } from "./turnkey-vault";

export type VaultStatus = {
  mode: string;
  initialized: boolean;
  subOrgName?: string;
};

/**
 * The vault's lifecycle: first initialisation, the status the operator polls, and the
 * cold-start rehydration that rebuilds everything from the volume.
 */
@Injectable()
export class VaultService {
  constructor(
    private readonly vault: TurnkeyKeyVault,
    private readonly vaultState: VaultStateRepository,
    private readonly wallets: WalletRepository,
    private readonly audit: AuditLog,
    @Inject(SIGNER_PROVIDER) private readonly provider: SignerProvider,
    @Inject(DPM_API) private readonly dpmApi: SubOrganizationCreator,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(ENCRYPTION_KEY) private readonly encryptionKey: EncryptionKey,
    @Inject(TRANSACTION) private readonly transaction: Transaction,
  ) {}

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
   * Nothing here talks to Turnkey. The sub-org and its HD wallet are both created in the
   * single activity dpm-api runs, so their identifiers arrive in its response and this
   * function only has to persist them. No account is derived yet: every address this install
   * issues is minted on demand by `POST /v1/addresses`.
   *
   * Idempotent by short-circuit rather than by upsert: once the state row says initialised
   * this returns what is already there and writes nothing.
   */
  async initialize(): Promise<VaultStatus> {
    const existing = this.vaultState.load();
    if (existing?.initialized) return this.status();

    const state = this.reserveApiKeyPair(existing);
    const apiKeyPair = this.readApiKeyPair(state);
    const subOrg = await this.dpmApi.createSubOrganization({
      apiPublicKey: apiKeyPair.apiPublicKey,
      walletName: this.config.turnkey.walletName,
    });

    this.provider.adoptCredentials({
      subOrgId: subOrg.subOrgId,
      walletId: subOrg.walletId,
      ...apiKeyPair,
    });
    this.vault.adopt({ subOrgId: subOrg.subOrgId, walletId: subOrg.walletId });

    // One transaction over both writes, so the trail can never claim an initialisation the
    // state row does not record. That row makes its one transition here, and no later call
    // can repair a half-written result.
    this.transaction(() => {
      this.vaultState.complete({
        subOrgId: subOrg.subOrgId,
        subOrgName: subOrg.subOrgName,
        turnkeyWalletId: subOrg.walletId,
      });
      this.audit.record({
        action: AuditAction.VaultInit,
        outcome: "success",
        detail: { subOrgId: subOrg.subOrgId, subOrgName: subOrg.subOrgName },
      });
    });

    logInfo("vault.initialized", { subOrgName: subOrg.subOrgName });
    return { mode: this.vault.mode, initialized: true, subOrgName: subOrg.subOrgName };
  }

  /**
   * Reports initialised only when both halves are in place: the sub-organisation the process
   * holds credentials for, and the row on the volume. A vault the container adopted that no
   * row records is a failed init that has yet to be retried, and saying otherwise would send
   * the operator away satisfied.
   */
  status(): VaultStatus {
    const adopted = this.vault.initializedState !== undefined;
    const state = this.vaultState.load();
    return {
      mode: this.vault.mode,
      initialized: state?.initialized === true && adopted,
      ...(state?.subOrgName ? { subOrgName: state.subOrgName } : {}),
    };
  }

  /**
   * Restores the vault from the volume: the sub-organisation credentials the container needs
   * to reach Turnkey at all, then the vault handle, then a check that the volume and the
   * sub-organisation still agree on which addresses exist.
   *
   * A divergence means the database came from a different install, or the container is pointed
   * at a different Turnkey sub-organisation. Continuing would silently mint a second, unrelated
   * address tree for refs that already have addresses — so this check aborts the boot rather
   * than surfacing as an HTTP error, and the server never binds.
   */
  async rehydrate(): Promise<void> {
    const state = this.vaultState.load();
    if (!state?.initialized) {
      // Also the interrupted-init case, where a key pair is reserved but no sub-organisation
      // exists yet: POST /v1/vault/init resumes it, and until then the provider stays
      // credential-less and every signing route reports 409.
      logInfo("startup.vault_uninitialized");
      return;
    }

    const credentials = this.readCredentials(state);
    this.provider.adoptCredentials(credentials);
    this.vault.adopt({ subOrgId: credentials.subOrgId, walletId: credentials.walletId });
    await this.assertVaultMatchesDbAddresses();
    logInfo("startup.vault_rehydrated", { subOrgName: state.subOrgName });
  }

  /**
   * Returns the state row this init runs against: the one an interrupted attempt already left
   * on the volume, or a new one holding a freshly minted key pair, written before anything
   * leaves the process.
   */
  private reserveApiKeyPair(existing: VaultStateRecord | undefined): VaultStateRecord {
    if (existing) {
      logInfo("vault.api_key_pair_resumed", { apiPublicKey: existing.subOrgApiPublicKey });
      return existing;
    }

    const generated = generateApiKeyPair();
    const reserved = this.vaultState.reserve(
      {
        mode: this.vault.mode,
        subOrgApiPublicKey: generated.publicKeyHex,
        subOrgApiPrivateKeyEncrypted: encryptCredential(
          this.encryptionKey,
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

  private readApiKeyPair(
    state: VaultStateRecord,
  ): Pick<ProviderCredentials, "apiPublicKey" | "apiPrivateKey"> {
    return {
      apiPublicKey: state.subOrgApiPublicKey,
      apiPrivateKey: decryptCredential(this.encryptionKey, state.subOrgApiPrivateKeyEncrypted),
    };
  }

  /**
   * Recovers what an initialised install acts with. A row marked initialised is expected to
   * carry all of it; a gap means the row was written by an incompatible build, and a boot that
   * continued would fail every request with a confusing Turnkey error instead of naming the
   * volume as the problem.
   */
  private readCredentials(state: VaultStateRecord): ProviderCredentials {
    if (!state.subOrgId || !state.turnkeyWalletId) {
      throw new DpmwError(
        "INTERNAL_ERROR",
        "VAULT_DB_MISMATCH: the vault state row is initialised but holds no sub-organization",
      );
    }
    return {
      subOrgId: state.subOrgId,
      walletId: state.turnkeyWalletId,
      apiPublicKey: state.subOrgApiPublicKey,
      apiPrivateKey: decryptCredential(this.encryptionKey, state.subOrgApiPrivateKeyEncrypted),
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
  private async assertVaultMatchesDbAddresses(): Promise<void> {
    const managedAddressesFromDb = this.wallets.allEoaAddresses();
    const heldByVault = new Set((await this.vault.listAddresses()).map(lower));

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
}

function lower(address: string): string {
  return address.toLowerCase();
}
