import { Inject, Injectable } from "@nestjs/common";
import { getAddress } from "viem";

import type { SubOrganizationCreator } from "../clients/dpm-api.client";
import type { Config } from "../config";
import { generateApiKeyPair } from "../crypto/api-key-pair";
import {
  decryptCredential,
  encryptCredential,
  type EncryptionKey,
} from "../crypto/credential-encryption";
import { deriveProxyAddress } from "../crypto/proxy-address";
import { VaultStateRepository, type VaultStateRecord } from "../db/repositories/vault-state.repo";
import {
  MASTER_DERIVATION_INDEX,
  MASTER_REF,
  WalletRepository,
  type Wallet,
} from "../db/repositories/wallet.repo";
import { DpmwError } from "../errors";
import { AuditAction } from "../observability/audit-action";
import { AuditLog } from "../observability/audit";
import { logInfo, logWarn } from "../observability/log";
import { CONFIG, DPM_API, ENCRYPTION_KEY, SIGNER_PROVIDER, TRANSACTION } from "../tokens";
import type { Transaction } from "../tokens";
import { derivationPath, type MasterInfo } from "./key-vault.interface";
import type { ProviderCredentials, SignerProvider } from "./providers/signer-provider.interface";
import { TurnkeyKeyVault } from "./turnkey-vault";

export type VaultStatus = {
  mode: string;
  initialized: boolean;
  master?: MasterInfo;
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
   * Nothing here talks to Turnkey. The sub-org, its HD wallet and the master account at index
   * 0 are all created in the single activity dpm-api runs, so their identifiers arrive in its
   * response and this function only has to persist them.
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
      masterDerivationPath: derivationPath(MASTER_DERIVATION_INDEX),
    });

    // Dated from the state row rather than the clock, so an install reports the same master
    // creation time before and after a restart.
    const master: MasterInfo = {
      address: subOrg.masterAddress,
      index: MASTER_DERIVATION_INDEX,
      createdAt: state.createdAt,
    };
    this.provider.adoptCredentials({
      subOrgId: subOrg.subOrgId,
      walletId: subOrg.walletId,
      ...apiKeyPair,
    });
    this.vault.adopt({ subOrgId: subOrg.subOrgId, walletId: subOrg.walletId, master });

    // One transaction over all three writes. A failure partway through — a unique-index
    // collision on the master row, say — would otherwise leave the vault marked initialised
    // with no master in the directory, a state no later call can repair because the row
    // makes its one transition here.
    this.transaction(() => {
      this.vaultState.complete({
        subOrgId: subOrg.subOrgId,
        subOrgName: subOrg.subOrgName,
        turnkeyWalletId: subOrg.walletId,
        masterAddress: master.address,
      });
      this.recordMaster(MASTER_REF, master.address);
      this.audit.record({
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
    return { mode: this.vault.mode, initialized: true, master };
  }

  /**
   * Reports initialised only when both halves are in place: the key in the custody backend and
   * the row on the volume. A vault holding a master that no row records is a failed init that
   * has yet to be retried, and saying otherwise would send the operator away satisfied.
   */
  status(): VaultStatus {
    const master = this.vault.initializedState?.master;
    const recorded = this.vaultState.load()?.initialized === true;
    return {
      mode: this.vault.mode,
      initialized: recorded && master !== undefined,
      ...(master ? { master } : {}),
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

    const { credentials, master } = this.readInitializedState(state);
    this.provider.adoptCredentials(credentials);
    this.vault.adopt({
      subOrgId: credentials.subOrgId,
      walletId: credentials.walletId,
      master,
    });
    await this.assertVaultMatchesDbAddresses();
    logInfo("startup.vault_rehydrated", {
      subOrgName: state.subOrgName,
      masterAddress: master.address,
    });
  }

  /**
   * Records the master in the directory so it can be addressed by ref like any wallet.
   * Called only from init, inside its transaction.
   */
  private recordMaster(ref: string, eoaAddress: Wallet["eoaAddress"]): Wallet {
    return this.wallets.insert({
      ref,
      role: "master",
      derivationIndex: MASTER_DERIVATION_INDEX,
      eoaAddress,
      proxyAddress: deriveProxyAddress(eoaAddress, this.config.contracts),
      turnkeyAccountId: null,
      createdAt: new Date().toISOString(),
    });
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
  private readInitializedState(state: VaultStateRecord): {
    credentials: ProviderCredentials;
    master: MasterInfo;
  } {
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
        apiPrivateKey: decryptCredential(this.encryptionKey, state.subOrgApiPrivateKeyEncrypted),
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
