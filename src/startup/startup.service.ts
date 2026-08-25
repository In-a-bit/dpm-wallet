import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";

import type { Db } from "../db/client";
import { IdempotencyRepository } from "../db/repositories/idempotency.repo";
import { logInfo } from "../observability/log";
import { DB } from "../tokens";
import { VaultService } from "../vault/vault.service";
import { assertSchemaPresent } from "./schema-check";
import { assertExchangeDomain } from "./self-check";

/** Idempotency records older than this are purged at boot; the retry window is much shorter. */
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Rebuilds the working state from the volume before the HTTP server binds. Nest runs this
 * hook after every provider is constructed and before `listen` resolves, so a failure here
 * takes the boot down rather than surfacing on the first request.
 *
 * That is the point: a container that cannot rehydrate its vault would otherwise mint a
 * second, unrelated address tree for refs that already have addresses.
 */
@Injectable()
export class StartupService implements OnApplicationBootstrap {
  constructor(
    private readonly vault: VaultService,
    private readonly idempotency: IdempotencyRepository,
    @Inject(DB) private readonly db: Db,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await assertSchemaPresent(this.db);
    assertExchangeDomain();
    await this.vault.rehydrate();
    await this.purgeExpiredIdempotencyKeys();
  }

  private async purgeExpiredIdempotencyKeys(): Promise<void> {
    const cutoff = new Date(Date.now() - IDEMPOTENCY_RETENTION_MS).toISOString();
    const purged = await this.idempotency.purgeOlderThan(cutoff);
    if (purged > 0) logInfo("startup.idempotency_purged", { purged });
  }
}
