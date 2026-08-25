import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import { isoTimestamp } from "../iso-timestamp";

/**
 * The address directory: wallet reference to EOA to proxy to derivation index.
 *
 * Addresses are stored EIP-55 checksummed — the canonical form, validated once on the way
 * in — so a read needs no normalisation. The casing-independent indices are on `lower(...)`
 * instead of the raw column, which keeps uniqueness and lookups working regardless.
 *
 * Those two are declared `synchronize: false` because an index over an expression cannot be
 * expressed on an entity: the migration creates them, and this tells the schema builder they
 * are accounted for rather than drift to be dropped on the next generate.
 */
@Entity("wallets")
@Index("wallets_eoa_lower", { synchronize: false })
@Index("wallets_proxy_lower", { synchronize: false })
export class WalletEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index("wallets_ref", { unique: true })
  @Column("text")
  ref!: string;

  @Index("wallets_index", { unique: true })
  @Column("integer", { name: "derivation_index" })
  derivationIndex!: number;

  @Column("text", { name: "eoa_address" })
  eoaAddress!: string;

  @Column("text", { name: "proxy_address" })
  proxyAddress!: string;

  @Column("text", { name: "turnkey_account_id", nullable: true })
  turnkeyAccountId!: string | null;

  @Column("boolean", { name: "dpm_registered", default: false })
  dpmRegistered!: boolean;

  @Column("timestamptz", { name: "created_at", transformer: isoTimestamp })
  createdAt!: string;
}
