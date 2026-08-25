import { Inject, Injectable } from "@nestjs/common";

import type { VaultMode } from "../../config";
import { DpmwError } from "../../errors";
import { DB } from "../../tokens";
import type { Db, Executor } from "../client";
import { VAULT_STATE_ID, VaultStateEntity } from "../entities";

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

  load(): Promise<VaultStateRecord | undefined> {
    return this.loadWith(this.db.manager);
  }

  /**
   * Phase one: records the generated key pair before anything is sent to dpm-api, so an
   * init interrupted partway resumes with the *same* key pair. Regenerating one would ask
   * dpm-api for a second sub-organization and be refused, leaving the install unable to
   * initialise at all.
   *
   * `orIgnore` is what makes the resume a read rather than a second insert: a row already
   * reserved stays untouched and is returned as it stands.
   */
  async reserve(credentials: ReservedCredentials, createdAt: string): Promise<VaultStateRecord> {
    await this.db
      .createQueryBuilder()
      .insert()
      .into(VaultStateEntity)
      .values({
        id: VAULT_STATE_ID,
        mode: credentials.mode,
        initialized: false,
        subOrgApiPublicKey: credentials.subOrgApiPublicKey,
        subOrgApiPrivateKeyEncrypted: credentials.subOrgApiPrivateKeyEncrypted,
        createdAt,
      })
      .orIgnore()
      .execute();

    const reserved = await this.load();
    if (!reserved) {
      throw new DpmwError("INTERNAL_ERROR", "Vault state could not be reserved");
    }
    return reserved;
  }

  /**
   * Phase two: the one transition this row ever makes. Guarded on `initialized = false` so a
   * second call cannot repoint an install at a different sub-organisation and orphan every
   * address already issued.
   */
  async complete(
    state: InitializedVaultState,
    executor: Executor = this.db.manager,
  ): Promise<VaultStateRecord> {
    const result = await executor.update(
      VaultStateEntity,
      { id: VAULT_STATE_ID, initialized: false },
      {
        initialized: true,
        subOrgId: state.subOrgId,
        subOrgName: state.subOrgName,
        turnkeyWalletId: state.turnkeyWalletId,
      },
    );

    if (!result.affected) {
      throw new DpmwError(
        "INTERNAL_ERROR",
        "Vault state is already initialized and immutable; refusing to overwrite it",
      );
    }

    // Read back through the same executor, so a caller inside a transaction sees the row it
    // just wrote rather than the pre-transaction one another connection would still return.
    const completed = await this.loadWith(executor);
    if (!completed) {
      throw new DpmwError("INTERNAL_ERROR", "Vault state disappeared while being initialized");
    }
    return completed;
  }

  private async loadWith(executor: Executor): Promise<VaultStateRecord | undefined> {
    const row = await executor.findOneBy(VaultStateEntity, { id: VAULT_STATE_ID });
    return row ? toRecord(row) : undefined;
  }
}

function toRecord(row: VaultStateEntity): VaultStateRecord {
  return {
    mode: row.mode as VaultMode,
    initialized: row.initialized,
    subOrgApiPublicKey: row.subOrgApiPublicKey,
    subOrgApiPrivateKeyEncrypted: row.subOrgApiPrivateKeyEncrypted,
    subOrgId: row.subOrgId,
    subOrgName: row.subOrgName,
    turnkeyWalletId: row.turnkeyWalletId,
    createdAt: row.createdAt,
  };
}
