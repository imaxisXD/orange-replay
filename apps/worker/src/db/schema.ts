import { desc, sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const orgs = sqliteTable(
  "orgs",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    slug: text("slug")
      .notNull()
      .default(sql`('legacy-' || lower(hex(randomblob(16))))`),
    logo: text("logo"),
    metadata: text("metadata"),
    shard: integer("shard").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] }), uniqueIndex("idx_orgs_slug").on(table.slug)],
);

export const projects = sqliteTable(
  "projects",
  {
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
  },
  (table) => [index("idx_projects_org_id").on(table.orgId)],
);

export const keys = sqliteTable(
  "keys",
  {
    keyHash: text("key_hash").notNull(),
    id: text("id")
      .notNull()
      .default(sql`('key_legacy_' || lower(hex(randomblob(16))))`),
    projectId: text("project_id").notNull(),
    name: text("name").notNull().default("Legacy key"),
    active: integer("active").notNull().default(1),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at"),
    revokedBy: text("revoked_by"),
    cacheSynced: integer("cache_synced").notNull().default(1),
    cacheFinalCheckAt: integer("cache_final_check_at"),
  },
  (table) => [
    primaryKey({ columns: [table.keyHash] }),
    uniqueIndex("idx_keys_id").on(table.id),
    index("idx_keys_project_active").on(table.projectId, table.active),
    index("idx_keys_cache_sync").on(table.active, table.cacheSynced, table.revokedAt),
    index("idx_keys_cache_final_check").on(table.active, table.cacheFinalCheckAt),
  ],
);

export const keyCacheWrites = sqliteTable(
  "key_cache_writes",
  {
    id: text("id").notNull(),
    keyHash: text("key_hash")
      .notNull()
      .references(() => keys.keyHash, { onDelete: "cascade" }),
    startedAt: integer("started_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("idx_key_cache_writes_hash").on(table.keyHash),
  ],
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified").notNull().default(0),
    image: text("image"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    role: text("role"),
    banned: integer("banned").notNull().default(0),
    banReason: text("ban_reason"),
    banExpires: integer("ban_expires"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("idx_users_email").on(table.email),
    index("idx_users_created_at").on(table.createdAt),
  ],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").notNull(),
    expiresAt: integer("expires_at").notNull(),
    token: text("token").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_org_id"),
    impersonatedBy: text("impersonated_by"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("idx_auth_sessions_token").on(table.token),
    index("idx_auth_sessions_user_id").on(table.userId),
    index("idx_auth_sessions_expires_at").on(table.expiresAt),
  ],
);

export const authAccounts = sqliteTable(
  "auth_accounts",
  {
    id: text("id").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at"),
    refreshTokenExpiresAt: integer("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("idx_auth_accounts_provider_account").on(table.providerId, table.accountId),
    index("idx_auth_accounts_user_id").on(table.userId),
  ],
);

export const authVerifications = sqliteTable(
  "auth_verifications",
  {
    id: text("id").notNull(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("idx_auth_verifications_identifier").on(table.identifier),
  ],
);

export const authRateLimits = sqliteTable(
  "auth_rate_limits",
  {
    id: text("id").notNull(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: integer("last_request").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("idx_auth_rate_limits_key").on(table.key),
  ],
);

export const members = sqliteTable(
  "members",
  {
    id: text("id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("idx_members_org_user").on(table.orgId, table.userId),
    index("idx_members_user_id").on(table.userId),
    index("idx_members_org_id").on(table.orgId),
  ],
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("idx_invitations_org_id").on(table.orgId),
    index("idx_invitations_email").on(table.email),
  ],
);

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
    indexedAt: integer("indexed_at").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.sessionId] }),
    index("idx_sessions_project_time").on(
      table.projectId,
      desc(table.startedAt),
      desc(table.sessionId),
    ),
    index("idx_sessions_project_indexed_at").on(
      table.projectId,
      desc(table.indexedAt),
      desc(table.sessionId),
    ),
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

export const projectPublicPages = sqliteTable(
  "project_public_pages",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(),
    isEnabled: integer("is_enabled").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    publishedAt: integer("published_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId] }),
    uniqueIndex("idx_project_public_pages_public_id").on(table.publicId),
    index("idx_project_public_pages_enabled").on(table.isEnabled, table.publicId),
  ],
);

export const publicPageSessions = sqliteTable(
  "public_page_sessions",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projectPublicPages.projectId, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    publicReplayId: text("public_replay_id").notNull(),
    position: integer("position").notNull(),
    addedAt: integer("added_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.sessionId] }),
    uniqueIndex("idx_public_page_sessions_replay_id").on(table.publicReplayId),
    uniqueIndex("idx_public_page_sessions_position").on(table.projectId, table.position),
    foreignKey({
      columns: [table.projectId, table.sessionId],
      foreignColumns: [sessions.projectId, sessions.sessionId],
    }).onDelete("cascade"),
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

export const analyticsExportOutbox = sqliteTable(
  "analytics_export_outbox",
  {
    exportSequence: integer("export_sequence").primaryKey({ autoIncrement: true }),
    exportId: text("export_id").notNull().unique(),
    projectId: text("project_id").notNull(),
    sessionId: text("session_id").notNull(),
    recordKind: text("record_kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at").notNull(),
    sentAt: integer("sent_at"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    quarantinedAt: integer("quarantined_at"),
    quarantineReason: text("quarantine_reason"),
    sidecarEventOffset: integer("sidecar_event_offset").notNull().default(0),
  },
  (table) => [
    index("idx_analytics_export_outbox_pending")
      .on(table.exportSequence)
      .where(sql`${table.sentAt} IS NULL AND ${table.quarantinedAt} IS NULL`),
    index("idx_analytics_export_outbox_project_sequence").on(table.projectId, table.exportSequence),
    index("idx_analytics_export_outbox_project_kind_sequence").on(
      table.projectId,
      table.recordKind,
      desc(table.exportSequence),
    ),
    index("idx_analytics_export_outbox_session_sequence").on(
      table.projectId,
      table.sessionId,
      table.recordKind,
      table.exportSequence,
    ),
  ],
);

export const analyticsExportLedger = sqliteTable(
  "analytics_export_ledger",
  {
    exportId: text("export_id").primaryKey(),
    exportSequence: integer("export_sequence").notNull().unique(),
    projectId: text("project_id").notNull(),
    sessionId: text("session_id").notNull(),
    recordKind: text("record_kind").notNull(),
    sentAt: integer("sent_at").notNull(),
    firstSeenVerifiedAt: integer("first_seen_verified_at").notNull(),
  },
  (table) => [
    index("idx_analytics_export_ledger_project_kind_sequence").on(
      table.projectId,
      table.recordKind,
      desc(table.exportSequence),
    ),
    index("idx_analytics_export_ledger_session_sequence").on(
      table.projectId,
      table.sessionId,
      table.recordKind,
      table.exportSequence,
    ),
  ],
);

export const analyticsWarehouseState = sqliteTable("analytics_warehouse_state", {
  projectId: text("project_id").primaryKey(),
  verifiedSequence: integer("verified_sequence").notNull().default(0),
  verifiedAt: integer("verified_at"),
  lastAttemptAt: integer("last_attempt_at"),
  lastError: text("last_error"),
});

export const analyticsExportLease = sqliteTable("analytics_export_lease", {
  shard: integer("shard").primaryKey(),
  ownerId: text("owner_id").notNull(),
  acquiredAt: integer("acquired_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  sendAvailableAt: integer("send_available_at").notNull().default(0),
});

export const analyticsDeletionJobs = sqliteTable(
  "analytics_deletion_jobs",
  {
    projectId: text("project_id").notNull(),
    sessionId: text("session_id").notNull(),
    requestedAt: integer("requested_at").notNull(),
    deleteReason: text("delete_reason").notNull(),
    requiresWarehouseTombstone: integer("requires_warehouse_tombstone", {
      mode: "boolean",
    })
      .notNull()
      .default(sql`1`),
    deletionExportSequence: integer("deletion_export_sequence"),
    purgeAttempts: integer("purge_attempts").notNull().default(0),
    purgeLastAttemptAt: integer("purge_last_attempt_at"),
    purgeLastError: text("purge_last_error"),
    firstZeroAt: integer("first_zero_at"),
    completedAt: integer("completed_at"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    alertedAt: integer("alerted_at"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.sessionId] }),
    index("idx_analytics_deletion_jobs_pending")
      .on(table.requestedAt, table.projectId, table.sessionId)
      .where(sql`${table.completedAt} IS NULL`),
  ],
);

export const analyticsBackfillCompletions = sqliteTable("analytics_backfill_completions", {
  projectId: text("project_id").primaryKey(),
  sourceSessionCount: integer("source_session_count").notNull(),
  sourceCutoffMs: integer("source_cutoff_ms").notNull(),
  requiredSequence: integer("required_sequence").notNull(),
  reportId: text("report_id").notNull(),
  completedAt: integer("completed_at").notNull(),
});
