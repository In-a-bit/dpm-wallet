import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";

import type { Config } from "./config";
import { closeDatabase, openDatabase, type Db } from "./db/client";
import { AuditRepository } from "./db/repositories/audit.repo";
import { IdempotencyRepository } from "./db/repositories/idempotency.repo";
import { VaultStateRepository } from "./db/repositories/vault-state.repo";
import { WalletRepository } from "./db/repositories/wallet.repo";
import { CONFIG, DB, TRANSACTION, type Transaction } from "./tokens";

const REPOSITORIES = [
  WalletRepository,
  AuditRepository,
  IdempotencyRepository,
  VaultStateRepository,
];

/**
 * Opens the volume before anything that reads it is constructed. Global because the
 * repositories it exports are needed across every feature.
 */
@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: (config: Config) => openDatabase(config.databasePath),
      inject: [CONFIG],
    },
    {
      provide: TRANSACTION,
      useFactory:
        (db: Db): Transaction =>
        (work) =>
          db.$client.transaction(work)(),
      inject: [DB],
    },
    ...REPOSITORIES,
  ],
  exports: [DB, TRANSACTION, ...REPOSITORIES],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Runs a final WAL checkpoint, folding the -wal contents back into the main file. Not
   * required for correctness — SQLite replays the WAL on the next open — but it leaves the
   * volume holding one self-contained file.
   */
  onApplicationShutdown(): void {
    closeDatabase(this.db);
  }
}
