import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * The vault's initialisation state — one row, always id 1, written with the API key pair
 * on first init and completed once the sub-organisation exists.
 *
 * It holds no signing key: the secp256k1 keys never leave the Turnkey TEE. What it does
 * hold is this install's Turnkey **API** credential, which authorises requests to its own
 * sub-organisation and nothing else. The private half is stored encrypted, so a copy of
 * the volume alone cannot act on the sub-org.
 *
 * The key pair is there from the first insert, because it is what dpm-api recognises a
 * retrying install by. The sub-org columns stay empty until dpm-api answers.
 */
export const vaultState = sqliteTable("vault_state", {
  id: integer("id").primaryKey(),
  mode: text("mode").notNull(),
  initialized: integer("initialized").notNull().default(0),
  subOrgApiPublicKey: text("sub_org_api_public_key").notNull(),
  subOrgApiPrivateKeyEncrypted: text("sub_org_api_private_key_encrypted").notNull(),
  subOrgId: text("sub_org_id"),
  subOrgName: text("sub_org_name"),
  turnkeyWalletId: text("turnkey_wallet_id"),
  masterAddress: text("master_address"),
  createdAt: text("created_at").notNull(),
});

/**
 * The address directory: wallet reference to EOA to proxy to derivation index.
 *
 * Addresses are stored EIP-55 checksummed — the canonical form, validated once on the way
 * in — so a read needs no normalisation. The indices are on `lower(...)` instead of the
 * raw column, which keeps uniqueness and lookups casing-independent regardless.
 */
export const wallets = sqliteTable(
  "wallets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ref: text("ref").notNull(),
    role: text("role").notNull(),
    derivationIndex: integer("derivation_index").notNull(),
    eoaAddress: text("eoa_address").notNull(),
    proxyAddress: text("proxy_address").notNull(),
    turnkeyAccountId: text("turnkey_account_id"),
    dpmRegistered: integer("dpm_registered").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("wallets_ref").on(table.ref),
    uniqueIndex("wallets_index").on(table.derivationIndex),
    uniqueIndex("wallets_eoa_lower").on(sql`lower(${table.eoaAddress})`),
    index("wallets_proxy_lower").on(sql`lower(${table.proxyAddress})`),
  ],
);

/**
 * The one audit trail: every signing action, address creation, and treasury movement, each
 * written exactly once by the service that performs it. Append-only, and never holds a
 * usable signature — the logger truncates those before they reach a row.
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ref: text("ref"),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    detail: text("detail"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("audit_events_ref").on(table.ref),
    index("audit_events_action").on(table.action),
    index("audit_events_created_at").on(table.createdAt),
  ],
);

/**
 * Replay protection for POST endpoints. Survives restart, so a client retrying across a
 * container restart gets the original response instead of a second signature.
 */
export const idempotencyKeys = sqliteTable("idempotency_keys", {
  key: text("key").primaryKey(),
  requestHash: text("request_hash").notNull(),
  responseJson: text("response_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const VAULT_STATE_ID = 1;

export type VaultStateRow = typeof vaultState.$inferSelect;
export type WalletRow = typeof wallets.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
