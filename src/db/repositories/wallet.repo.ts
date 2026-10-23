import { Inject, Injectable } from "@nestjs/common";
import type { Repository } from "typeorm";
import { getAddress, type Address } from "viem";

import { DB } from "../../tokens";
import type { Db } from "../client";
import { WalletEntity } from "../entities";

export type Wallet = {
  ref: string;
  derivationIndex: number;
  eoaAddress: Address;
  proxyAddress: Address;
  turnkeyAccountId: string | null;
  dpmRegistered: boolean;
  createdAt: string;
};

export type NewWallet = {
  ref: string;
  derivationIndex: number;
  eoaAddress: Address;
  proxyAddress: Address;
  turnkeyAccountId: string | null;
  createdAt: string;
};

export type WalletPage = {
  wallets: Wallet[];
  total: number;
};

@Injectable()
export class WalletRepository {
  private readonly wallets: Repository<WalletEntity>;

  constructor(@Inject(DB) db: Db) {
    this.wallets = db.getRepository(WalletEntity);
  }

  async findByRef(ref: string): Promise<Wallet | undefined> {
    const row = await this.wallets.findOneBy({ ref });
    return row ? toWallet(row) : undefined;
  }

  /** Addresses are matched case-insensitively: callers hold them checksummed or lowercased. */
  async findByEoaAddress(address: string): Promise<Wallet | undefined> {
    const row = await this.wallets
      .createQueryBuilder("w")
      .where("lower(w.eoa_address) = lower(:address)", { address })
      .getOne();
    return row ? toWallet(row) : undefined;
  }

  async list(limit: number, offset: number): Promise<WalletPage> {
    const [rows, total] = await this.wallets.findAndCount({
      order: { derivationIndex: "ASC" },
      take: limit,
      skip: offset,
    });
    return { wallets: rows.map(toWallet), total };
  }

  /**
   * One page of EOAs in derivation order, strictly after `afterIndex` (-1 to start). Keyset
   * rather than offset, so the boot-time walk over the whole directory stays cheap at any size.
   */
  async eoaAddressPage(
    afterIndex: number,
    limit: number,
  ): Promise<{ addresses: Address[]; lastIndex: number }> {
    const rows = await this.wallets
      .createQueryBuilder("w")
      .select(["w.derivationIndex", "w.eoaAddress"])
      .where("w.derivation_index > :afterIndex", { afterIndex })
      .orderBy("w.derivation_index", "ASC")
      .take(limit)
      .getMany();
    return {
      addresses: rows.map((row) => row.eoaAddress as Address),
      lastIndex: rows.at(-1)?.derivationIndex ?? afterIndex,
    };
  }

  /**
   * The highest index in use, or -1 when the directory is empty. Read from the database
   * rather than memory or config, so a restart can never reissue an index.
   */
  async maxDerivationIndex(): Promise<number> {
    return (await this.wallets.maximum("derivationIndex")) ?? -1;
  }

  /**
   * The one place addresses are validated and canonicalised. `getAddress` rejects a
   * malformed or mis-checksummed address here, at the boundary, so every later read is a
   * plain string fetch of a value already known to be well-formed.
   */
  async insert(wallet: NewWallet): Promise<Wallet> {
    const row = await this.wallets.save(
      this.wallets.create({
        ref: wallet.ref,
        derivationIndex: wallet.derivationIndex,
        eoaAddress: getAddress(wallet.eoaAddress),
        proxyAddress: getAddress(wallet.proxyAddress),
        turnkeyAccountId: wallet.turnkeyAccountId,
        dpmRegistered: false,
        createdAt: wallet.createdAt,
      }),
    );
    return toWallet(row);
  }

  async markDpmRegistered(ref: string, registered: boolean): Promise<Wallet | undefined> {
    const result = await this.wallets.update({ ref }, { dpmRegistered: registered });
    return result.affected ? this.findByRef(ref) : undefined;
  }
}

function toWallet(row: WalletEntity): Wallet {
  return {
    ref: row.ref,
    derivationIndex: row.derivationIndex,
    eoaAddress: row.eoaAddress as Address,
    proxyAddress: row.proxyAddress as Address,
    turnkeyAccountId: row.turnkeyAccountId,
    dpmRegistered: row.dpmRegistered,
    createdAt: row.createdAt,
  };
}
