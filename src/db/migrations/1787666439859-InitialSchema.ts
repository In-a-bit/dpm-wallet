import type { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1787666439859 implements MigrationInterface {
  name = "InitialSchema1787666439859";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "audit_events" ("id" SERIAL NOT NULL, "ref" text, "action" text NOT NULL, "outcome" text NOT NULL, "detail" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_910f64d901a5c3e9878f0d4a407" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "audit_events_ref" ON "audit_events" ("ref")`);
    await queryRunner.query(`CREATE INDEX "audit_events_action" ON "audit_events" ("action")`);
    await queryRunner.query(
      `CREATE INDEX "audit_events_created_at" ON "audit_events" ("created_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE "idempotency_keys" ("key" text NOT NULL, "request_hash" text NOT NULL, "response_json" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_0afd83cbf08c9d12089a9bffc5e" PRIMARY KEY ("key"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "vault_state" ("id" integer NOT NULL, "mode" text NOT NULL, "initialized" boolean NOT NULL DEFAULT false, "sub_org_api_public_key" text NOT NULL, "sub_org_api_private_key_encrypted" text NOT NULL, "sub_org_id" text, "sub_org_name" text, "turnkey_wallet_id" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_ab699a362352d37d6705f82e785" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "wallets" ("id" SERIAL NOT NULL, "ref" text NOT NULL, "derivation_index" integer NOT NULL, "eoa_address" text NOT NULL, "proxy_address" text NOT NULL, "turnkey_account_id" text, "dpm_registered" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_8402e5df5a30a229380e83e4f7e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "wallets_ref" ON "wallets" ("ref")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "wallets_index" ON "wallets" ("derivation_index")`,
    );

    // Written by hand: an index over an expression cannot be declared on an entity, so these
    // two are the `synchronize: false` indexes named on `WalletEntity`. They keep address
    // uniqueness and lookups casing-independent even though the stored form is checksummed.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "wallets_eoa_lower" ON "wallets" (lower("eoa_address"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "wallets_proxy_lower" ON "wallets" (lower("proxy_address"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."wallets_proxy_lower"`);
    await queryRunner.query(`DROP INDEX "public"."wallets_eoa_lower"`);
    await queryRunner.query(`DROP INDEX "public"."wallets_index"`);
    await queryRunner.query(`DROP INDEX "public"."wallets_ref"`);
    await queryRunner.query(`DROP TABLE "wallets"`);
    await queryRunner.query(`DROP TABLE "vault_state"`);
    await queryRunner.query(`DROP TABLE "idempotency_keys"`);
    await queryRunner.query(`DROP INDEX "public"."audit_events_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."audit_events_action"`);
    await queryRunner.query(`DROP INDEX "public"."audit_events_ref"`);
    await queryRunner.query(`DROP TABLE "audit_events"`);
  }
}
