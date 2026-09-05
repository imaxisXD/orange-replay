-- Schema checkpoint through Wrangler migration 0029.
-- This generated diff includes historical changes already applied by Wrangler.
-- Do not apply it as a separate database migration; use migrations/ only.
CREATE TABLE `accepted_usage_sessions` (
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`org_id` text NOT NULL,
	`month` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `accepted_usage_sessions_pk` PRIMARY KEY(`project_id`, `session_id`)
);
--> statement-breakpoint
CREATE TABLE `analytics_backfill_completions` (
	`project_id` text PRIMARY KEY,
	`source_session_count` integer NOT NULL,
	`source_cutoff_ms` integer NOT NULL,
	`required_sequence` integer NOT NULL,
	`report_id` text NOT NULL,
	`completed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analytics_deletion_jobs` (
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`requested_at` integer NOT NULL,
	`delete_reason` text NOT NULL,
	`requires_warehouse_tombstone` integer DEFAULT 1 NOT NULL,
	`deletion_export_sequence` integer,
	`purge_attempts` integer DEFAULT 0 NOT NULL,
	`purge_last_attempt_at` integer,
	`purge_last_error` text,
	`first_zero_at` integer,
	`completed_at` integer,
	`lease_owner` text,
	`lease_expires_at` integer,
	`alerted_at` integer,
	`session_started_at` integer,
	`deletion_v2_sent_at` integer,
	`deletion_v2_visible_at` integer,
	`deletion_v2_attempt_count` integer DEFAULT 0 NOT NULL,
	`deletion_v2_last_error` text,
	CONSTRAINT `analytics_deletion_jobs_pk` PRIMARY KEY(`project_id`, `session_id`)
);
--> statement-breakpoint
CREATE TABLE `analytics_deletion_v2_state` (
	`shard` integer PRIMARY KEY,
	`required_job_count` integer DEFAULT 0 NOT NULL,
	`visible_job_count` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`last_error` text,
	`backfill_completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `analytics_export_lease` (
	`shard` integer PRIMARY KEY,
	`owner_id` text NOT NULL,
	`acquired_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`send_available_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analytics_export_ledger` (
	`export_id` text PRIMARY KEY,
	`export_sequence` integer NOT NULL UNIQUE,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`record_kind` text NOT NULL,
	`sent_at` integer NOT NULL,
	`first_seen_verified_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analytics_export_outbox` (
	`export_sequence` integer PRIMARY KEY AUTOINCREMENT,
	`export_id` text NOT NULL UNIQUE,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`record_kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`quarantined_at` integer,
	`quarantine_reason` text,
	`sidecar_event_offset` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analytics_read_budget` (
	`scope` text PRIMARY KEY,
	`window_start` integer NOT NULL,
	`request_count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analytics_warehouse_state` (
	`project_id` text PRIMARY KEY,
	`verified_sequence` integer DEFAULT 0 NOT NULL,
	`verified_at` integer,
	`last_attempt_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `auth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_auth_accounts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `auth_rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`active_org_id` text,
	`impersonated_by` text,
	CONSTRAINT `fk_auth_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `auth_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`inviter_id` text NOT NULL,
	CONSTRAINT `fk_invitations_org_id_orgs_id_fk` FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_invitations_inviter_id_users_id_fk` FOREIGN KEY (`inviter_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `key_cache_writes` (
	`id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`started_at` integer NOT NULL,
	CONSTRAINT `fk_key_cache_writes_key_hash_keys_key_hash_fk` FOREIGN KEY (`key_hash`) REFERENCES `keys`(`key_hash`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_members_org_id_orgs_id_fk` FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `project_public_pages` (
	`project_id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`is_enabled` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`published_at` integer,
	`updated_at` integer NOT NULL,
	`mutation_token` text,
	CONSTRAINT `fk_project_public_pages_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `project_websites` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`origin` text NOT NULL,
	`allowed_origins` text NOT NULL,
	`first_event_at` integer,
	`first_session_id` text,
	`recorder_key_id` text,
	`recorder_secret_ciphertext` text,
	`recorder_secret_iv` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_project_websites_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `public_page_sessions` (
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`public_replay_id` text NOT NULL,
	`position` integer NOT NULL,
	`added_at` integer NOT NULL,
	CONSTRAINT `public_page_sessions_pk` PRIMARY KEY(`project_id`, `session_id`),
	CONSTRAINT `fk_public_page_sessions_project_id_project_public_pages_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_public_pages`(`project_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_public_page_sessions_project_id_session_id_sessions_project_id_session_id_fk` FOREIGN KEY (`project_id`,`session_id`) REFERENCES `sessions`(`project_id`,`session_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `replay_asset_attempts` (
	`project_id` text NOT NULL,
	`source_url_hash` text NOT NULL,
	`day` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `replay_asset_attempts_pk` PRIMARY KEY(`project_id`, `source_url_hash`, `day`),
	CONSTRAINT `fk_replay_asset_attempts_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `replay_asset_fetch_budgets` (
	`project_id` text NOT NULL,
	`day` text NOT NULL,
	`fetches` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `replay_asset_fetch_budgets_pk` PRIMARY KEY(`project_id`, `day`),
	CONSTRAINT `fk_replay_asset_fetch_budgets_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `replay_asset_objects` (
	`asset_hash` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL UNIQUE,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `replay_asset_urls` (
	`project_id` text NOT NULL,
	`source_url_hash` text NOT NULL,
	`asset_hash` text NOT NULL,
	`fetched_at` integer NOT NULL,
	CONSTRAINT `replay_asset_urls_pk` PRIMARY KEY(`project_id`, `source_url_hash`),
	CONSTRAINT `fk_replay_asset_urls_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_replay_asset_urls_asset_hash_replay_asset_objects_asset_hash_fk` FOREIGN KEY (`asset_hash`) REFERENCES `replay_asset_objects`(`asset_hash`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `replay_project_assets` (
	`project_id` text NOT NULL,
	`asset_hash` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `replay_project_assets_pk` PRIMARY KEY(`project_id`, `asset_hash`),
	CONSTRAINT `fk_replay_project_assets_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_replay_project_assets_asset_hash_replay_asset_objects_asset_hash_fk` FOREIGN KEY (`asset_hash`) REFERENCES `replay_asset_objects`(`asset_hash`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `replay_session_assets` (
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`parent_hash` text DEFAULT '' NOT NULL,
	`source_url_hash` text NOT NULL,
	`asset_hash` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `replay_session_assets_pk` PRIMARY KEY(`project_id`, `session_id`, `parent_hash`, `source_url_hash`),
	CONSTRAINT `fk_replay_session_assets_asset_hash_replay_asset_objects_asset_hash_fk` FOREIGN KEY (`asset_hash`) REFERENCES `replay_asset_objects`(`asset_hash`) ON DELETE CASCADE,
	CONSTRAINT `fk_replay_session_assets_project_id_session_id_sessions_project_id_session_id_fk` FOREIGN KEY (`project_id`,`session_id`) REFERENCES `sessions`(`project_id`,`session_id`) ON DELETE CASCADE
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT 0 NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`role` text,
	`banned` integer DEFAULT 0 NOT NULL,
	`ban_reason` text,
	`ban_expires` integer
);
--> statement-breakpoint
ALTER TABLE `keys` ADD `id` text DEFAULT ('key_legacy_' || lower(hex(randomblob(16)))) NOT NULL;--> statement-breakpoint
ALTER TABLE `keys` ADD `name` text DEFAULT 'Legacy key' NOT NULL;--> statement-breakpoint
ALTER TABLE `keys` ADD `created_by` text;--> statement-breakpoint
ALTER TABLE `keys` ADD `revoked_at` integer;--> statement-breakpoint
ALTER TABLE `keys` ADD `revoked_by` text;--> statement-breakpoint
ALTER TABLE `keys` ADD `cache_synced` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `keys` ADD `cache_final_check_at` integer;--> statement-breakpoint
ALTER TABLE `keys` ADD `website_id` text;--> statement-breakpoint
ALTER TABLE `orgs` ADD `slug` text DEFAULT ('legacy-' || lower(hex(randomblob(16)))) NOT NULL;--> statement-breakpoint
ALTER TABLE `orgs` ADD `logo` text;--> statement-breakpoint
ALTER TABLE `orgs` ADD `metadata` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `session_cookie_domain` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `replay_assets_enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_deletions` ADD `delete_analytics` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `indexed_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `has_checkpoint` integer;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_session_deletions` (
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`requested_at` integer NOT NULL,
	`delete_analytics` integer DEFAULT true NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	CONSTRAINT `session_deletions_pk` PRIMARY KEY(`project_id`, `session_id`),
	CONSTRAINT "session_deletions_delete_analytics" CHECK("delete_analytics" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_session_deletions`(`project_id`, `session_id`, `requested_at`, `attempts`, `last_error`) SELECT `project_id`, `session_id`, `requested_at`, `attempts`, `last_error` FROM `session_deletions`;--> statement-breakpoint
DROP TABLE `session_deletions`;--> statement-breakpoint
ALTER TABLE `__new_session_deletions` RENAME TO `session_deletions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_accepted_usage_sessions_org_month` ON `accepted_usage_sessions` (`org_id`,`month`);--> statement-breakpoint
CREATE INDEX `idx_analytics_deletion_jobs_pending` ON `analytics_deletion_jobs` (`requested_at`,`project_id`,`session_id`) WHERE "analytics_deletion_jobs"."completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_analytics_deletion_jobs_v2_pending` ON `analytics_deletion_jobs` (`deletion_v2_visible_at`,`deletion_v2_sent_at`,`deletion_v2_attempt_count`,`requested_at`,`project_id`,`session_id`) WHERE "analytics_deletion_jobs"."requires_warehouse_tombstone" = 1;--> statement-breakpoint
CREATE INDEX `idx_analytics_export_ledger_project_kind_sequence` ON `analytics_export_ledger` (`project_id`,`record_kind`,"export_sequence" desc);--> statement-breakpoint
CREATE INDEX `idx_analytics_export_ledger_session_sequence` ON `analytics_export_ledger` (`project_id`,`session_id`,`record_kind`,`export_sequence`);--> statement-breakpoint
CREATE INDEX `idx_analytics_export_outbox_pending` ON `analytics_export_outbox` (`export_sequence`) WHERE "analytics_export_outbox"."sent_at" IS NULL AND "analytics_export_outbox"."quarantined_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_analytics_export_outbox_project_sequence` ON `analytics_export_outbox` (`project_id`,`export_sequence`);--> statement-breakpoint
CREATE INDEX `idx_analytics_export_outbox_project_kind_sequence` ON `analytics_export_outbox` (`project_id`,`record_kind`,"export_sequence" desc);--> statement-breakpoint
CREATE INDEX `idx_analytics_export_outbox_session_sequence` ON `analytics_export_outbox` (`project_id`,`session_id`,`record_kind`,`export_sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_auth_accounts_provider_account` ON `auth_accounts` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `idx_auth_accounts_user_id` ON `auth_accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_auth_rate_limits_key` ON `auth_rate_limits` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_auth_sessions_token` ON `auth_sessions` (`token`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_user_id` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_expires_at` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_verifications_identifier` ON `auth_verifications` (`identifier`);--> statement-breakpoint
CREATE INDEX `idx_invitations_org_id` ON `invitations` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_invitations_email` ON `invitations` (`email`);--> statement-breakpoint
CREATE INDEX `idx_key_cache_writes_hash` ON `key_cache_writes` (`key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_keys_id` ON `keys` (`id`);--> statement-breakpoint
CREATE INDEX `idx_keys_project_active` ON `keys` (`project_id`,`active`);--> statement-breakpoint
CREATE INDEX `idx_keys_website_active` ON `keys` (`website_id`,`active`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_keys_one_active_website_key` ON `keys` (`website_id`) WHERE "keys"."website_id" IS NOT NULL AND "keys"."active" = 1;--> statement-breakpoint
CREATE INDEX `idx_keys_cache_sync` ON `keys` (`active`,`cache_synced`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_keys_cache_final_check` ON `keys` (`active`,`cache_final_check_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_members_org_user` ON `members` (`org_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_members_user_id` ON `members` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_members_org_id` ON `members` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_orgs_slug` ON `orgs` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_public_pages_public_id` ON `project_public_pages` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_public_pages_mutation_token` ON `project_public_pages` (`mutation_token`);--> statement-breakpoint
CREATE INDEX `idx_project_public_pages_enabled` ON `project_public_pages` (`is_enabled`,`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_websites_origin` ON `project_websites` (`project_id`,`origin`);--> statement-breakpoint
CREATE INDEX `idx_project_websites_project_created` ON `project_websites` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_projects_org_id` ON `projects` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_public_page_sessions_replay_id` ON `public_page_sessions` (`public_replay_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_public_page_sessions_position` ON `public_page_sessions` (`project_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_replay_session_assets_hash` ON `replay_session_assets` (`project_id`,`session_id`,`asset_hash`);--> statement-breakpoint
CREATE INDEX `idx_replay_session_assets_expiry` ON `replay_session_assets` (`expires_at`,`project_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `idx_session_finalization_jobs_due` ON `session_finalization_jobs` (`next_attempt_at`,`project_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_indexed_at` ON `sessions` (`project_id`,"indexed_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_city_time` ON `sessions` (`project_id`,`city`,"started_at" desc,"session_id" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_created_at` ON `users` (`created_at`);