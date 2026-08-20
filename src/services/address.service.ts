import type { Config } from "../config.js";
import { addressNotFound, refAlreadyExists, vaultNotInitialized } from "../errors.js";
import type { Wallet, WalletPage, WalletRepository } from "../db/repositories/wallet.repo.js";
import { MASTER_DERIVATION_INDEX } from "../db/repositories/wallet.repo.js";
import { deriveProxyAddress } from "../crypto/proxy-address.js";
import { AuditAction } from "../observability/audit-action.js";
import { AuditLog } from "../observability/audit.js";
import type { KeyVault } from "../vault/key-vault.interface.js";

/**
 * Creates and reads user wallets. Every address this service mints is a user wallet at the
 * next free index — there is no role parameter, because an operator wallet backing a
 * shared balance is an ordinary user wallet here. The master is created only by vault init.
 */
export class AddressService {
  /**
   * Tail of the allocation queue: see `runExclusive` below for why an in-process queue is
   * both sufficient and necessary.
   */
  private queueTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly wallets: WalletRepository,
    private readonly vault: KeyVault,
    private readonly config: Config,
    private readonly audit: AuditLog,
  ) {}

  create(ref: string): Promise<Wallet> {
    return this.runExclusive(() => this.createNextUserWallet(ref));
  }

  get(ref: string): Wallet {
    const wallet = this.wallets.findByRef(ref);
    if (!wallet) throw addressNotFound(ref);
    return wallet;
  }

  list(limit: number, offset: number): WalletPage {
    return this.wallets.list(limit, offset);
  }

  /**
   * Records that the DPM platform has registered this wallet's EOA. Meta-transaction
   * signing depends on it: `GET /relay-payload` resolves the RelayHub nonce from the DPM
   * `users` table, so an unregistered EOA cannot yield one.
   */
  setDpmRegistered(ref: string, registered: boolean): Wallet {
    const wallet = this.wallets.markDpmRegistered(ref, registered);
    if (!wallet) throw addressNotFound(ref);
    this.audit.record({
      ref,
      action: AuditAction.AddressDpmRegistered,
      outcome: "success",
      detail: { registered },
    });
    return wallet;
  }

  /**
   * Records the master in the directory so it can be addressed by ref like any wallet.
   * Called only from vault init, inside its transaction.
   */
  recordMaster(ref: string, eoaAddress: Wallet["eoaAddress"]): Wallet {
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

  private async createNextUserWallet(ref: string): Promise<Wallet> {
    this.assertVaultInitialized();
    if (this.wallets.findByRef(ref)) throw refAlreadyExists(ref);

    const index = this.nextUserIndex();
    const account = await this.vault.createAccount(index, ref);
    const wallet = this.wallets.insert({
      ref,
      role: "user",
      derivationIndex: index,
      eoaAddress: account.address,
      proxyAddress: deriveProxyAddress(account.address, this.config.contracts),
      turnkeyAccountId: account.accountId,
      createdAt: new Date().toISOString(),
    });
    this.audit.record({
      ref,
      action: AuditAction.AddressCreate,
      outcome: "success",
      detail: {
        index: wallet.derivationIndex,
        address: wallet.eoaAddress,
        proxyAddress: wallet.proxyAddress,
      },
    });
    return wallet;
  }

  /**
   * The HTTP layer gates on this too, but the check is repeated here because index
   * allocation is only correct relative to a master that exists: without one, index 0 is
   * free and the first user wallet would claim the master's derivation path.
   */
  private assertVaultInitialized(): void {
    if (!this.wallets.findByRole("master")) throw vaultNotInitialized();
  }

  /** User wallets start at 1; index 0 always belongs to the master. */
  private nextUserIndex(): number {
    return Math.max(this.wallets.maxDerivationIndex(), MASTER_DERIVATION_INDEX) + 1;
  }

  /**
   * Runs `work` only after every previously queued call has settled, so two concurrent
   * creates cannot both read the same `MAX(derivation_index)` and race to insert the same
   * index. That gap is real rather than theoretical: the vault call sits between the read
   * and the insert, so Node interleaves other requests in the middle of it. The spec allows
   * exactly one writer against the SQLite volume (§14.3), which is what makes an in-process
   * queue sufficient — with a second replica this would have to become a database lock.
   */
  private runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queueTail.then(work, work);
    // Swallow rejections on the queue handle only: one failed create must not reject the
    // next caller, while `result` still rejects for the caller that owns it.
    this.queueTail = result.catch(() => undefined);
    return result;
  }
}
