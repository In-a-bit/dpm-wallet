import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Idempotency keys are now scoped by method and route, and a request reserves its key before
 * it runs: a NULL `response_json` marks a request still in flight. Existing rows are keyed by
 * the bare header value and could never match a scoped key again, so they are dropped — they
 * are a 24h retry cache, not state.
 */
export class IdempotencyPending1787753000000 implements MigrationInterface {
  name = "IdempotencyPending1787753000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "idempotency_keys"`);
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" ALTER COLUMN "response_json" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "idempotency_keys" WHERE "response_json" IS NULL`);
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" ALTER COLUMN "response_json" SET NOT NULL`,
    );
  }
}
