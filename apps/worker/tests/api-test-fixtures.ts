import { createHmac } from "node:crypto";
import {
  manifestKey,
  sessionPrefix,
  type ProjectConfig,
  type SessionManifest,
} from "@orange-replay/shared";
import type { SessionRow } from "../src/api/helpers.ts";

export const token = "test-token-0000000000000000000000";
export const liveTicketSecret = "test-live-ticket-secret-0000000000";
export const listProjectId = "api_list_project";
export const entryPageProjectId = "api_entry_page_project";
export const sameTimeProjectId = "api_same_time_project";
export const assetProjectId = "api_asset_project";
export const assetSessionId = "api_asset_session";
export const liveProjectId = "api_live_project";
export const installProjectId = "api_install_project";
export const configProjectId = "api_config_project";
export const keysProjectId = "api_keys_project";
export const ticketProjectId = "api_ticket_project";
export const ticketSessionId = "api_ticket_session";
export const demoProjectId = "api_demo_project";
export const demoOtherProjectId = "api_demo_other_project";
export const demoSessionId = "api_demo_session";
export const demoWriteKey = "or_live_demo0000000000000000000000000000";
export const apiProjectIds = [
  listProjectId,
  entryPageProjectId,
  sameTimeProjectId,
  assetProjectId,
  liveProjectId,
  installProjectId,
  configProjectId,
  keysProjectId,
  ticketProjectId,
].join(",");
export const segmentName = "seg-000001.ors";
export const segmentBytes = new Uint8Array([0, 1, 2, 3, 254, 255]);

export function makeSession(overrides: Partial<SessionRow>): SessionRow {
  const sessionId = overrides.session_id ?? "api_session";
  const projectId = overrides.project_id ?? listProjectId;
  const startedAt = overrides.started_at ?? 1000;
  const durationMs = overrides.duration_ms ?? 1000;

  return {
    session_id: sessionId,
    project_id: projectId,
    org_id: overrides.org_id ?? "api_org",
    started_at: startedAt,
    ended_at: overrides.ended_at ?? startedAt + durationMs,
    duration_ms: durationMs,
    country: overrides.country ?? "US",
    region: overrides.region ?? null,
    city: overrides.city ?? null,
    device: overrides.device ?? "desktop",
    browser: overrides.browser ?? "Chrome",
    os: overrides.os ?? "macOS",
    entry_url: overrides.entry_url ?? "/",
    url_count: overrides.url_count ?? 1,
    page_count: overrides.page_count === undefined ? 1 : overrides.page_count,
    analytics_version: overrides.analytics_version ?? 1,
    max_scroll_depth: overrides.max_scroll_depth ?? null,
    quick_backs: overrides.quick_backs ?? null,
    interaction_time_ms: overrides.interaction_time_ms ?? null,
    activity_hist: overrides.activity_hist ?? null,
    clicks: overrides.clicks ?? 0,
    errors: overrides.errors ?? 0,
    rages: overrides.rages ?? 0,
    navs: overrides.navs ?? 0,
    bytes: overrides.bytes ?? 0,
    segment_count: overrides.segment_count ?? 0,
    flags: overrides.flags ?? 0,
    manifest_key: overrides.manifest_key ?? manifestKey(projectId, sessionId),
    expires_at: overrides.expires_at ?? 9_999_999_999,
  };
}

export function makeManifest(
  session: SessionRow,
  segments: { name: string; bytes: Uint8Array }[],
): SessionManifest {
  return {
    v: 1,
    sessionId: session.session_id,
    projectId: session.project_id,
    orgId: session.org_id,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    durationMs: session.duration_ms,
    segments: segments.map((segment) => ({
      key: `${sessionPrefix(session.project_id, session.session_id)}/${segment.name}`,
      bytes: segment.bytes.byteLength,
      t0: session.started_at,
      t1: session.ended_at,
      batches: 1,
    })),
    timeline: [],
    counts: {
      batches: segments.length,
      events: 0,
      clicks: session.clicks,
      errors: session.errors,
      rages: session.rages,
      navs: session.navs,
    },
    bytes: session.bytes,
    flags: session.flags,
    attrs: {
      country: session.country ?? undefined,
      region: session.region ?? undefined,
      city: session.city ?? undefined,
      device: session.device ?? undefined,
      browser: session.browser ?? undefined,
      os: session.os ?? undefined,
      entryUrl: session.entry_url ?? undefined,
      urlCount: session.url_count,
      pageCount: session.page_count ?? undefined,
    },
  };
}

export function signLiveTicket(projectId: string, sessionId: string, expiresAt: number): string {
  return signLiveTicketWithSecret(liveTicketSecret, projectId, sessionId, expiresAt);
}

export function signLiveTicketWithSecret(
  secret: string,
  projectId: string,
  sessionId: string,
  expiresAt: number,
): string {
  const signature = createHmac("sha256", secret)
    .update(`${projectId}:${sessionId}:${expiresAt}`)
    .digest("base64url");
  return Buffer.from(`${expiresAt}.${signature}`).toString("base64url");
}

export function makeProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    projectId: "api_project",
    orgId: "api_org",
    shard: 0,
    active: true,
    sampleRate: 1,
    allowedOrigins: ["*"],
    maskPolicyVersion: 1,
    maskRules: [],
    capture: {
      heatmaps: false,
      console: false,
      network: false,
      canvas: false,
    },
    quotaState: "ok",
    retentionDays: 30,
    version: 1,
    ...overrides,
  };
}

export function testWriteKey(label: string): string {
  return `or_live_${label
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .padEnd(32, "0")
    .slice(0, 32)}`;
}
