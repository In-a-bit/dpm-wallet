import { Inject, Injectable } from "@nestjs/common";
import { LessThan, type Repository } from "typeorm";

import { DB } from "../../tokens";
import type { Db } from "../client";
import { IdempotencyKeyEntity } from "../entities";

/** Idempotency records older than this are purged; the retry window is much shorter. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * A reservation older than this belongs to a process that died mid-request (no request here
 * runs this long), so a retry may take the key over rather than be refused until the purge.
 */
export const IDEMPOTENCY_PENDING_TIMEOUT_MS = 5 * 60 * 1000;

export type IdempotencyRecord = {
  requestHash: string;
  /** Absent while the request that reserved the key is still running. */
  responseJson?: string;
};

@Injectable()
export class IdempotencyRepository {
  private readonly keys: Repository<IdempotencyKeyEntity>;

  constructor(@Inject(DB) private readonly db: Db) {
    this.keys = db.getRepository(IdempotencyKeyEntity);
  }

  async find(key: string): Promise<IdempotencyRecord | undefined> {
    const row = await this.keys.findOneBy({ key });
    if (!row) return undefined;
    return {
      requestHash: row.requestHash,
      ...(row.responseJson === null ? {} : { responseJson: row.responseJson }),
    };
  }

  /**
   * Claims the key for the request about to run. `ON CONFLICT DO NOTHING` rather than a
   * check-then-insert: two concurrent requests carrying the same key would both pass the
   * check, and both would execute. Exactly one insert returns a row.
   */
  async reserve(key: string, requestHash: string, createdAt: string): Promise<boolean> {
    const result = await this.db
      .createQueryBuilder()
      .insert()
      .into(IdempotencyKeyEntity)
      .values({ key, requestHash, responseJson: null, createdAt })
      .orIgnore()
      .returning("key")
      .execute();
    return (result.raw as unknown[]).length > 0;
  }

  /** Stores the response on the reservation, completing it. */
  async complete(key: string, responseJson: string): Promise<void> {
    await this.keys.update({ key }, { responseJson });
  }

  /** Releases a reservation whose request failed, so a retry reaches the handler. */
  async release(key: string): Promise<void> {
    await this.keys
      .createQueryBuilder()
      .delete()
      .where(`"key" = :key AND "response_json" IS NULL`, { key })
      .execute();
  }

  /** Drops the key if it is a reservation older than `cutoff`; returns whether it did. */
  async releaseIfStale(key: string, cutoff: string): Promise<boolean> {
    const result = await this.keys
      .createQueryBuilder()
      .delete()
      .where(`"key" = :key AND "response_json" IS NULL AND "created_at" < :cutoff`, {
        key,
        cutoff,
      })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async purgeOlderThan(cutoff: string): Promise<number> {
    const result = await this.keys.delete({ createdAt: LessThan(cutoff) });
    return result.affected ?? 0;
  }
}
