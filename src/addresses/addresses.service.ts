import { LP_ATTESTATION_MESSAGE } from "@inabit-com/dpm-sdk/turnkey";
import { Inject, Injectable } from "@nestjs/common";
import type { Address, Hex } from "viem";

import type { Config } from "../config";
import { deriveProxyAddress } from "../crypto/proxy-address";
import { WalletRepository, type Wallet, type WalletPage } from "../db/repositories/wallet.repo";
import { addressNotFound, refAlreadyExists } from "../errors";
import { AuditAction } from "../observability/audit-action";
import { AuditLog } from "../observability/audit";
import { CONFIG, KEY_VAULT } from "../tokens";
import type { KeyVault } from "../vault/key-vault.interface";

/** The pair the DPM registration call takes: the EOA and its proof of control. */
export type DpmAttestation = {
  address: Address;
  signature: Hex;
};

/**
 * Creates and reads wallets. Every address this service mints is the same kind of thing at
 * the next free index: an operator wallet backing a shared balance and an end user's wallet
 * are indistinguishable here, and carry exactly the same capabilities.
 */
@Injectable()
export class AddressesService {
  /**
   * Tail of the allocation queue: see `runExclusive` below for why an in-process queue is
   * both sufficient and necessary.
   */
  private queueTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly wallets: WalletRepository,
    private readonly audit: AuditLog,
    @Inject(KEY_VAULT) private readonly vault: KeyVault,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  create(ref: string): Promise<Wallet> {
    return this.runExclusive(() => this.createNextWallet(ref));
  }

  async get(ref: string): Promise<Wallet> {
    const wallet = await this.wallets.findByRef(ref);
    if (!wallet) throw addressNotFound(ref);
    return wallet;
  }

  list(limit: number, offset: number): Promise<WalletPage> {
    return this.wallets.list(limit, offset);
  }

  /**
   * Signs the attestation the DPM platform requires to register this wallet's EOA. The
   * message is fixed and carries no address, so the platform learns which key signed it by
   * recovering the signer — which is the whole proof, since only this vault can produce it.
   */
  async signDpmAttestation(ref: string): Promise<DpmAttestation> {
    const wallet = await this.get(ref);
    const signature = await this.vault.personalSign(wallet.eoaAddress, LP_ATTESTATION_MESSAGE);
    await this.audit.record({
      ref,
      action: AuditAction.AddressDpmAttestation,
      outcome: "success",
      detail: { address: wallet.eoaAddress },
    });
    return { address: wallet.eoaAddress, signature };
  }

  /**
   * Records that the DPM platform has registered this wallet's EOA. Meta-transaction
   * signing depends on it: `GET /relay-payload` resolves the RelayHub nonce from the DPM
   * `users` table, so an unregistered EOA cannot yield one.
   */
  async setDpmRegistered(ref: string, registered: boolean): Promise<Wallet> {
    const wallet = await this.wallets.markDpmRegistered(ref, registered);
    if (!wallet) throw addressNotFound(ref);
    await this.audit.record({
      ref,
      action: AuditAction.AddressDpmRegistered,
      outcome: "success",
      detail: { registered },
    });
    return wallet;
  }

  private async createNextWallet(ref: string): Promise<Wallet> {
    if (await this.wallets.findByRef(ref)) throw refAlreadyExists(ref);

    const index = await this.nextIndex();
    const account = await this.vault.createAccount(index, ref);
    const wallet = await this.wallets.insert({
      ref,
      derivationIndex: index,
      eoaAddress: account.address,
      proxyAddress: deriveProxyAddress(account.address, this.config.contracts),
      turnkeyAccountId: account.accountId,
      createdAt: new Date().toISOString(),
    });
    await this.audit.record({
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

  /** The first wallet an install issues takes index 0; the directory owns the whole tree. */
  private async nextIndex(): Promise<number> {
    return (await this.wallets.maxDerivationIndex()) + 1;
  }

  /**
   * Runs `work` only after every previously queued call has settled, so two concurrent
   * creates cannot both read the same `MAX(derivation_index)` and race to insert the same
   * index. That gap is real rather than theoretical: the vault call sits between the read
   * and the insert, so Node interleaves other requests in the middle of it. This serialises
   * one process only; a second replica would need a database-level lock. The unique index on
   * `derivation_index` is the backstop either way — it turns a lost race into a failed insert
   * rather than two customers sharing an address.
   */
  private runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queueTail.then(work, work);
    // Swallow rejections on the queue handle only: one failed create must not reject the
    // next caller, while `result` still rejects for the caller that owns it.
    this.queueTail = result.catch(() => undefined);
    return result;
  }
}
