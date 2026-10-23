import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import {
  IDEMPOTENCY_RETENTION_MS,
  IdempotencyRepository,
} from "../db/repositories/idempotency.repo";
import { logError, logInfo } from "../observability/log";

const FIRST_RUN_DELAY_MS = 60_000;
const RUN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Keeps the idempotency table small on a long-running install. Audit rows are not touched here:
 * the manager decides those cutoffs and drives them through `/v1/maintenance`.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private firstRun?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly idempotency: IdempotencyRepository) {}

  onModuleInit(): void {
    this.firstRun = setTimeout(() => {
      void this.runOnce();
      this.interval = setInterval(() => void this.runOnce(), RUN_INTERVAL_MS);
      this.interval.unref();
    }, FIRST_RUN_DELAY_MS);
    this.firstRun.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.firstRun);
    clearInterval(this.interval);
  }

  /** Never throws and never overlaps a run still in flight. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cutoff = new Date(Date.now() - IDEMPOTENCY_RETENTION_MS).toISOString();
      const idempotency_keys = await this.idempotency.purgeOlderThan(cutoff);
      logInfo("retention.run", { idempotency_keys });
    } catch (err) {
      logError("retention.failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
  }
}
