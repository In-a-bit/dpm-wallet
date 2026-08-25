import { Column, Entity, PrimaryColumn } from "typeorm";

import { isoTimestamp } from "../iso-timestamp";

/** The row is a singleton, so its key is a constant rather than something generated. */
export const VAULT_STATE_ID = 1;

/**
 * The vault's initialisation state — one row, always id 1, written with the API key pair
 * on first init and completed once the sub-organisation exists.
 *
 * It holds no signing key: the secp256k1 keys never leave the Turnkey TEE. What it does
 * hold is this install's Turnkey **API** credential, which authorises requests to its own
 * sub-organisation and nothing else. The private half is stored encrypted, so a copy of
 * the database alone cannot act on the sub-org.
 *
 * The key pair is there from the first insert, because it is what dpm-api recognises a
 * retrying install by. The sub-org columns stay empty until dpm-api answers.
 */
@Entity("vault_state")
export class VaultStateEntity {
  @PrimaryColumn("integer")
  id!: number;

  @Column("text")
  mode!: string;

  @Column("boolean", { default: false })
  initialized!: boolean;

  @Column("text", { name: "sub_org_api_public_key" })
  subOrgApiPublicKey!: string;

  @Column("text", { name: "sub_org_api_private_key_encrypted" })
  subOrgApiPrivateKeyEncrypted!: string;

  @Column("text", { name: "sub_org_id", nullable: true })
  subOrgId!: string | null;

  @Column("text", { name: "sub_org_name", nullable: true })
  subOrgName!: string | null;

  @Column("text", { name: "turnkey_wallet_id", nullable: true })
  turnkeyWalletId!: string | null;

  @Column("timestamptz", { name: "created_at", transformer: isoTimestamp })
  createdAt!: string;
}
