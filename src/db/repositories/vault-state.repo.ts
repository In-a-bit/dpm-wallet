import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import type { VaultMode } from "../../config";
import { DpmwError } from "../../errors";
import { DB } from "../../tokens";
import type { Db } from "../client";
import { VAULT_STATE_ID, vaultState, type VaultStateRow } from "../schema";

/**
 * The row as it is read back. The key pair is always there — the row cannot be inserted
 * without it — while the sub-org columns are filled only once dpm-api has answered, so an
 * interrupted init is exactly the case where they are still null.
 */
export type VaultStateRecord = {
  mode: VaultMode;
  initialized: boolean;
  subOrgApiPublicKey: string;
  subOrgApiPrivateKeyEncrypted: string;
  subOrgId: string | null;
  subOrgName: string | null;
  turnkeyWalletId: string | null;
  createdAt: string;
};

/** The key pair this install presents to Turnkey, written before the sub-org is asked for. */
export type ReservedCredentials = {
  mode: VaultMode;
  subOrgApiPublicKey: string;
  subOrgApiPrivateKeyEncrypted: string;
};

/** What dpm-api reported: the sub-org the key pair governs, and its HD wallet. */
export type InitializedVaultState = {
  subOrgId: string;
  subOrgName: string;
  turnkeyWalletId: string;
};

@Injectable()
export class VaultStateRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  load(): VaultStateRecord | undefined {
    const [row] = this.db.select().from(vaultState).where(eq(vaultState.id, VAULT_STATE_ID)).all();
    return row ? toRecord(row) : undefined;
  }

  /**
   * Phase one: records the generated key pair before anything is sent to dpm-api, so an
   * init interrupted partway resumes with the *same* key pair. Regenerating one would ask
   * dpm-api for a second sub-organization and be refused, leaving the install unable to
   * initialise at all.
   *
   * Returns the existing row when one is already reserved, which is what makes the resume
   * a read rather than a second insert.
   */
  reserve(credentials: ReservedCredentials, createdAt: string): VaultStateRecord {
    const [row] = this.db
      .insert(vaultState)
      .values({
        id: VAULT_STATE_ID,
        mode: credentials.mode,
        initialized: 0,
        subOrgApiPublicKey: credentials.subOrgApiPublicKey,
        subOrgApiPrivateKeyEncrypted: credentials.subOrgApiPrivateKeyEncrypted,
        createdAt,
      })
      .onConflictDoNothing({ target: vaultState.id })
      .returning()
      .all();
    if (row) return toRecord(row);

    const existing = this.load();
    if (!existing) {
      throw new DpmwError("INTERNAL_ERROR", "Vault state could not be reserved");
    }
    return existing;
  }

  /**
   * Phase two: the one transition this row ever makes. Guarded on `initialized = 0` so a
   * second call cannot repoint an install at a different sub-organisation and orphan every
   * address already issued.
   */
  complete(state: InitializedVaultState): VaultStateRecord {
    const [row] = this.db
      .update(vaultState)
      .set({
        initialized: 1,
        subOrgId: state.subOrgId,
        subOrgName: state.subOrgName,
        turnkeyWalletId: state.turnkeyWalletId,
      })
      .where(and(eq(vaultState.id, VAULT_STATE_ID), eq(vaultState.initialized, 0)))
      .returning()
      .all();

    if (!row) {
      throw new DpmwError(
        "INTERNAL_ERROR",
        "Vault state is already initialized and immutable; refusing to overwrite it",
      );
    }
    return toRecord(row);
  }
}

function toRecord(row: VaultStateRow): VaultStateRecord {
  return {
    mode: row.mode as VaultMode,
    initialized: row.initialized === 1,
    subOrgApiPublicKey: row.subOrgApiPublicKey,
    subOrgApiPrivateKeyEncrypted: row.subOrgApiPrivateKeyEncrypted,
    subOrgId: row.subOrgId ?? null,
    subOrgName: row.subOrgName ?? null,
    turnkeyWalletId: row.turnkeyWalletId ?? null,
    createdAt: row.createdAt,
  };
}
