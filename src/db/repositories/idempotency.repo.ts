import { Inject, Injectable } from "@nestjs/common";
import { LessThan, type Repository } from "typeorm";

import { DB } from "../../tokens";
import type { Db } from "../client";
import { IdempotencyKeyEntity } from "../entities";

export type IdempotencyRecord = {
  requestHash: string;
  responseJson: string;
};

@Injectable()
export class IdempotencyRepository {
  private readonly keys: Repository<IdempotencyKeyEntity>;

  constructor(@Inject(DB) private readonly db: Db) {
    this.keys = db.getRepository(IdempotencyKeyEntity);
  }

  async find(key: string): Promise<IdempotencyRecord | undefined> {
    const row = await this.keys.findOneBy({ key });
    return row ? { requestHash: row.requestHash, responseJson: row.responseJson } : undefined;
  }

  /**
   * `orIgnore` rather than a check-then-insert: two concurrent requests carrying the same key
   * would both pass the check, and the loser would fail the insert instead of being a no-op.
   */
  async save(key: string, record: IdempotencyRecord, createdAt: string): Promise<void> {
    await this.db
      .createQueryBuilder()
      .insert()
      .into(IdempotencyKeyEntity)
      .values({ key, ...record, createdAt })
      .orIgnore()
      .execute();
  }

  async purgeOlderThan(cutoff: string): Promise<number> {
    const result = await this.keys.delete({ createdAt: LessThan(cutoff) });
    return result.affected ?? 0;
  }
}
