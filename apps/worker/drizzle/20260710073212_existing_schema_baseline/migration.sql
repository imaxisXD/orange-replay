CREATE TABLE `keys` (
	`key_hash` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orgs` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`shard` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`jurisdiction` text,
	`retention_days` integer DEFAULT 30 NOT NULL,
	`sample_rate` real DEFAULT 1 NOT NULL,
	`allowed_origins` text NOT NULL,
	`mask_policy_version` integer DEFAULT 1 NOT NULL,
	`mask_rules` text DEFAULT '[]' NOT NULL,
	`capture_toggles` text DEFAULT '{"heatmaps":false,"console":false,"network":false,"canvas":false}' NOT NULL,
	`quota_state` text DEFAULT 'ok' NOT NULL,
	`config_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_deletions` (
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`requested_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	CONSTRAINT `session_deletions_pk` PRIMARY KEY(`project_id`, `session_id`)
);
--> statement-breakpoint
CREATE TABLE `session_events` (
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`t` integer NOT NULL,
	`kind` text NOT NULL,
	`detail` text,
	CONSTRAINT `session_events_pk` PRIMARY KEY(`project_id`, `session_id`, `t`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`org_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`country` text,
	`region` text,
	`city` text,
	`device` text,
	`browser` text,
	`os` text,
	`entry_url` text,
	`url_count` integer DEFAULT 0 NOT NULL,
	`page_count` integer,
	`analytics_version` integer DEFAULT 0 NOT NULL,
	`max_scroll_depth` integer,
	`quick_backs` integer,
	`interaction_time_ms` integer,
	`clicks` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`rages` integer DEFAULT 0 NOT NULL,
	`navs` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`segment_count` integer DEFAULT 0 NOT NULL,
	`flags` integer DEFAULT 0 NOT NULL,
	`manifest_key` text NOT NULL,
	`expires_at` integer NOT NULL,
	`activity_hist` text,
	CONSTRAINT `sessions_pk` PRIMARY KEY(`project_id`, `session_id`)
);
--> statement-breakpoint
CREATE TABLE `usage_monthly` (
	`org_id` text NOT NULL,
	`month` text NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `usage_monthly_pk` PRIMARY KEY(`org_id`, `month`)
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_project_time` ON `sessions` (`project_id`,"started_at" desc);--> statement-breakpoint
CREATE INDEX `idx_sessions_expiry` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_country_time` ON `sessions` (`project_id`,`country`,"started_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_region_time` ON `sessions` (`project_id`,`region`,"started_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_device_time` ON `sessions` (`project_id`,`device`,"started_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_browser_time` ON `sessions` (`project_id`,`browser`,"started_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_os_time` ON `sessions` (`project_id`,`os`,"started_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_entry_url_time` ON `sessions` (`project_id`,`entry_url`,"started_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_errors_time` ON `sessions` (`project_id`,`errors`,"started_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_duration_time` ON `sessions` (`project_id`,`duration_ms`,"started_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_rages_time` ON `sessions` (`project_id`,`rages`,"started_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_quick_backs_time` ON `sessions` (`project_id`,`quick_backs`,"started_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_analytics_version_time` ON `sessions` (`project_id`,`analytics_version`,"started_at" desc,"session_id" desc);