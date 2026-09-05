-- DDL generated from src/db/schema.ts by Drizzle; copied from
-- drizzle/20260905050826_architecture_recovery_checkpoint/migration.sql.
-- Wrangler applies this additive migration after 0027.
CREATE TABLE `session_finalization_jobs` (
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`org_id` text NOT NULL,
	`object_id` text NOT NULL,
	`shard` integer NOT NULL,
	`retention_days` integer NOT NULL,
	`started_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`state` text DEFAULT 'recording' NOT NULL,
	`receipt_hash` text,
	`ended_at` integer,
	`expires_at` integer,
	`analytics_sidecar_key` text,
	`next_attempt_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	CONSTRAINT `session_finalization_jobs_pk` PRIMARY KEY(`project_id`, `session_id`)
);
CREATE INDEX `idx_session_finalization_jobs_due` ON `session_finalization_jobs` (`next_attempt_at`,`project_id`,`session_id`);
