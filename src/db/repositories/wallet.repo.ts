import { Inject, Injectable } from "@nestjs/common";
import { asc, eq, sql } from "drizzle-orm";
import { getAddress, type Address } from "viem";

import type { Db } from "../client";
import { DB } from "../../tokens";
import { wallets, type WalletRow } from "../schema";

/** The only two roles the service recognises; see §6.3 of the spec. */
export type WalletRole = "master" | "user";

export const MASTER_DERIVATION_INDEX = 0;

/**
 * The ref the master is addressed by, in the directory and in the custody backend alike. Both
 * sides must agree on it, so neither spells it out for itself.
 */
export const MASTER_REF = "master";

export type Wallet = {
  ref: string;
  role: WalletRole;
  derivationIndex: number;
  eoaAddress: Address;
  proxyAddress: Address;
  turnkeyAccountId: string | null;
  dpmRegistered: boolean;
  createdAt: string;
};

export type NewWallet = {
  ref: string;
  role: WalletRole;
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
  constructor(@Inject(DB) private readonly db: Db) {}

  findByRef(ref: string): Wallet | undefined {
    const [row] = this.db.select().from(wallets).where(eq(wallets.ref, ref)).all();
    return row ? toWallet(row) : undefined;
  }

  /** Matches on the case-insensitive index, so callers may pass any casing. */
  findByEoa(eoaAddress: string): Wallet | undefined {
    const [row] = this.db
      .select()
      .from(wallets)
      .where(sql`lower(${wallets.eoaAddress}) = ${eoaAddress.toLowerCase()}`)
      .all();
    return row ? toWallet(row) : undefined;
  }

  findByProxy(proxyAddress: string): Wallet | undefined {
    const [row] = this.db
      .select()
      .from(wallets)
      .where(sql`lower(${wallets.proxyAddress}) = ${proxyAddress.toLowerCase()}`)
      .all();
    return row ? toWallet(row) : undefined;
  }

  /** The master row, or undefined before vault init. There is at most one. */
  findByRole(role: WalletRole): Wallet | undefined {
    const [row] = this.db.select().from(wallets).where(eq(wallets.role, role)).all();
    return row ? toWallet(row) : undefined;
  }

  list(limit: number, offset: number): WalletPage {
    const rows = this.db
      .select()
      .from(wallets)
      .orderBy(asc(wallets.derivationIndex))
      .limit(limit)
      .offset(offset)
      .all();
    return { wallets: rows.map(toWallet), total: this.count() };
  }

  /** Every EOA in the directory, for the boot-time reconciliation against the custody backend. */
  allEoaAddresses(): Address[] {
    const rows = this.db.select({ eoaAddress: wallets.eoaAddress }).from(wallets).all();
    return rows.map((row) => row.eoaAddress as Address);
  }

  /**
   * The highest index in use, or -1 when the directory is empty. Read from the database
   * rather than memory or config, so a restart can never reissue an index.
   */
  maxDerivationIndex(): number {
    const [row] = this.db
      .select({ max: sql<number | null>`MAX(${wallets.derivationIndex})` })
      .from(wallets)
      .all();
    return row?.max ?? -1;
  }

  /**
   * The one place addresses are validated and canonicalised. `getAddress` rejects a
   * malformed or mis-checksummed address here, at the boundary, so every later read is a
   * plain string fetch of a value already known to be well-formed.
   */
  insert(wallet: NewWallet): Wallet {
    const [row] = this.db
      .insert(wallets)
      .values({
        ref: wallet.ref,
        role: wallet.role,
        derivationIndex: wallet.derivationIndex,
        eoaAddress: getAddress(wallet.eoaAddress),
        proxyAddress: getAddress(wallet.proxyAddress),
        turnkeyAccountId: wallet.turnkeyAccountId,
        dpmRegistered: 0,
        createdAt: wallet.createdAt,
      })
      .returning()
      .all();
    return toWallet(row!);
  }

  markDpmRegistered(ref: string, registered: boolean): Wallet | undefined {
    const [row] = this.db
      .update(wallets)
      .set({ dpmRegistered: registered ? 1 : 0 })
      .where(eq(wallets.ref, ref))
      .returning()
      .all();
    return row ? toWallet(row) : undefined;
  }

  private count(): number {
    const [row] = this.db
      .select({ total: sql<number>`COUNT(*)` })
      .from(wallets)
      .all();
    return row?.total ?? 0;
  }
}

function toWallet(row: WalletRow): Wallet {
  return {
    ref: row.ref,
    role: row.role as WalletRole,
    derivationIndex: row.derivationIndex,
    eoaAddress: row.eoaAddress as Address,
    proxyAddress: row.proxyAddress as Address,
    turnkeyAccountId: row.turnkeyAccountId ?? null,
    dpmRegistered: row.dpmRegistered === 1,
    createdAt: row.createdAt,
  };
}
