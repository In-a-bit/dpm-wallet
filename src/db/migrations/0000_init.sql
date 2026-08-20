CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ref` text,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_ref` ON `audit_events` (`ref`);--> statement-breakpoint
CREATE INDEX `audit_events_action` ON `audit_events` (`action`);--> statement-breakpoint
CREATE INDEX `audit_events_created_at` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vault_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`initialized` integer DEFAULT 0 NOT NULL,
	`sub_org_api_public_key` text NOT NULL,
	`sub_org_api_private_key_encrypted` text NOT NULL,
	`sub_org_id` text,
	`sub_org_name` text,
	`turnkey_wallet_id` text,
	`master_address` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ref` text NOT NULL,
	`role` text NOT NULL,
	`derivation_index` integer NOT NULL,
	`eoa_address` text NOT NULL,
	`proxy_address` text NOT NULL,
	`turnkey_account_id` text,
	`dpm_registered` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallets_ref` ON `wallets` (`ref`);--> statement-breakpoint
CREATE UNIQUE INDEX `wallets_index` ON `wallets` (`derivation_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `wallets_eoa_lower` ON `wallets` (lower("eoa_address"));--> statement-breakpoint
CREATE INDEX `wallets_proxy_lower` ON `wallets` (lower("proxy_address"));