import { desc } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const orgs = sqliteTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  shard: integer("shard").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  jurisdiction: text("jurisdiction"),
  retentionDays: integer("retention_days").notNull().default(30),
  sampleRate: real("sample_rate").notNull().default(1),
  allowedOrigins: text("allowed_origins").notNull(),
  maskPolicyVersion: integer("mask_policy_version").notNull().default(1),
  maskRules: text("mask_rules").notNull().default("[]"),
  captureToggles: text("capture_toggles")
    .notNull()
    .default('{"heatmaps":false,"console":false,"network":false,"canvas":false}'),
  quotaState: text("quota_state").notNull().default("ok"),
  configVersion: integer("config_version").notNull().default(1),
  createdAt: integer("created_at").notNull(),
});

export const keys = sqliteTable("keys", {
  keyHash: text("key_hash").primaryKey(),
  projectId: text("project_id").notNull(),
  active: integer("active").notNull().default(1),
  createdAt: integer("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    sessionId: text("session_id").notNull(),
    projectId: text("project_id").notNull(),
    orgId: text("org_id").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at").notNull(),
    durationMs: integer("duration_ms").notNull(),
    country: text("country"),
    region: text("region"),
    city: text("city"),
    device: text("device"),
    browser: text("browser"),
    os: text("os"),
    entryUrl: text("entry_url"),
    urlCount: integer("url_count").notNull().default(0),
    pageCount: integer("page_count"),
    analyticsVersion: integer("analytics_version").notNull().default(0),
    maxScrollDepth: integer("max_scroll_depth"),
    quickBacks: integer("quick_backs"),
    interactionTimeMs: integer("interaction_time_ms"),
    clicks: integer("clicks").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    rages: integer("rages").notNull().default(0),
    navs: integer("navs").notNull().default(0),
    bytes: integer("bytes").notNull().default(0),
    segmentCount: integer("segment_count").notNull().default(0),
    flags: integer("flags").notNull().default(0),
    manifestKey: text("manifest_key").notNull(),
    expiresAt: integer("expires_at").notNull(),
    activityHist: text("activity_hist"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.sessionId] }),
    index("idx_sessions_project_time").on(table.projectId, desc(table.startedAt)),
    index("idx_sessions_expiry").on(table.expiresAt),
    index("idx_sessions_project_country_time").on(
      table.projectId,
      table.country,
      desc(table.startedAt),
      desc(table.sessionId),
    ),
    index("idx_sessions_project_region_time").on(
      table.projectId,
      table.region,
      desc(table.startedAt),
      desc(table.sessionId),
    ),
    index("idx_sessions_project_device_time").on(
      table.projectId,
      table.device,
      desc(table.startedAt),
      desc(table.sessionId),
    ),
    index("idx_sessions_project_browser_time").on(
      table.projectId,
      table.browser,
      desc(table.startedAt),
      desc(table.sessionId),
    ),
    index("idx_sessions_project_os_time").on(
      table.projectId,
      table.os,
      desc(table.startedAt),
      desc(table.sessionId),
    ),
    index("idx_sessions_project_entry_url_time").on(
      table.projectId,
      table.entryUrl,
      desc(table.startedAt),
      desc(table.sessionId),
    ),
    index("idx_sessions_project_errors_time").on(
      table.projectId,
      table.errors,
      desc(table.startedAt),
      desc(table.sessionId),
    ),
    index("idx_sessions_project_duration_time").on(
      table.projectId,
      table.durationMs,
      desc(table.startedAt),
      desc(table.sessionId),
    ),
    index("idx_sessions_project_rages_time").on(
      table.projectId,
      table.rages,
      desc(table.startedAt),
      desc(table.sessionId),
    ),
    index("idx_sessions_project_quick_backs_time").on(
      table.projectId,
      table.quickBacks,
      desc(table.startedAt),
      desc(table.sessionId),
    ),
    index("idx_sessions_project_analytics_version_time").on(
      table.projectId,
      table.analyticsVersion,
      desc(table.startedAt),
      desc(table.sessionId),
    ),
  ],
);

export const sessionEvents = sqliteTable(
  "session_events",
  {
    projectId: text("project_id").notNull(),
    sessionId: text("session_id").notNull(),
    t: integer("t").notNull(),
    kind: text("kind").notNull(),
    detail: text("detail"),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.sessionId, table.t, table.kind] })],
);

export const usageMonthly = sqliteTable(
  "usage_monthly",
  {
    orgId: text("org_id").notNull(),
    month: text("month").notNull(),
    sessions: integer("sessions").notNull().default(0),
    bytes: integer("bytes").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.month] })],
);

export const sessionDeletions = sqliteTable(
  "session_deletions",
  {
    projectId: text("project_id").notNull(),
    sessionId: text("session_id").notNull(),
    requestedAt: integer("requested_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.sessionId] })],
);
