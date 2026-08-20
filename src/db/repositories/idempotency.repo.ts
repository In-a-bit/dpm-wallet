import { eq, lt } from "drizzle-orm";

import type { Db } from "../client.js";
import { idempotencyKeys } from "../schema.js";

export type IdempotencyRecord = {
  requestHash: string;
  responseJson: string;
};

export class IdempotencyRepository {
  constructor(private readonly db: Db) {}

  find(key: string): IdempotencyRecord | undefined {
    const [row] = this.db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .all();
    return row ? { requestHash: row.requestHash, responseJson: row.responseJson } : undefined;
  }

  save(key: string, record: IdempotencyRecord, createdAt: string): void {
    this.db
      .insert(idempotencyKeys)
      .values({ key, ...record, createdAt })
      .onConflictDoNothing({ target: idempotencyKeys.key })
      .run();
  }

  purgeOlderThan(cutoff: string): number {
    return this.db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, cutoff)).run()
      .changes;
  }
}
