import {
  CLOSE_SESSION_AFTER_IDLE_MS,
  manifestKey,
  sessionManifestSchema,
  type SessionFilter,
  type SessionManifest,
} from "@orange-replay/shared";
import { shardDb, type Env } from "../env.ts";
import { listProjectSessionHeads, readProjectSessionHead } from "../do/presence-client.ts";
import {
  SESSION_HEAD_HANDOFF_GRACE_MS,
  type PresenceHeadQuery,
  type PresenceSessionHead,
} from "../do/presence-logic.ts";
import {
  buildSessionWhere,
  isValidPathId,
  parseSessionListQuery,
  sessionRowColumns,
  type SessionListOptions,
  type SessionRow,
  type SessionSort,
} from "./helpers.ts";
import { jsonError, jsonResponse } from "./http.ts";

export type SessionHeadActivity = "live" | "idle" | "finalizing" | "complete";
export type SessionHeadDetails = "provisional" | "exact";
export type SessionHeadReplaySource = "live" | "recorded";

export interface SessionHead extends SessionRow {
  activity: SessionHeadActivity;
  details_state: SessionHeadDetails;
  replay_source: SessionHeadReplaySource;
}

const NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
  vary: "Authorization",
} as const;

const SESSION_HEAD_CANDIDATE_LIMIT = 100;
const SESSION_HEAD_RESPONSE_LIMIT = 200;

export const sessionHeadCandidateSql = {
  outbox: `SELECT session_id, export_sequence
    FROM analytics_export_outbox INDEXED BY idx_analytics_export_outbox_project_kind_sequence
    WHERE project_id = ? AND record_kind = 'session' AND export_sequence > ?
    ORDER BY export_sequence DESC
    LIMIT ?`,
  ledger: `SELECT session_id, export_sequence
    FROM analytics_export_ledger INDEXED BY idx_analytics_export_ledger_project_kind_sequence
    WHERE project_id = ? AND record_kind = 'session' AND export_sequence > ?
    ORDER BY export_sequence DESC
    LIMIT ?`,
  started: `SELECT session_id
    FROM sessions INDEXED BY idx_sessions_project_time
    WHERE project_id = ? AND started_at > ?
    ORDER BY started_at DESC, session_id DESC
    LIMIT ?`,
  indexed: `SELECT session_id
    FROM sessions INDEXED BY idx_sessions_project_indexed_at
    WHERE project_id = ? AND indexed_at >= ?
    ORDER BY indexed_at DESC, session_id DESC
    LIMIT ?`,
  latestIndexed: `SELECT session_id
    FROM sessions INDEXED BY idx_sessions_project_indexed_at
    WHERE project_id = ?
    ORDER BY indexed_at DESC, session_id DESC
    LIMIT ?`,
} as const;

interface SessionHeadControls {
  openedAt: number;
  warehouseTo?: number;
  trackedSessionIds: string[];
}

interface SessionHeadCandidateRow {
  session_id: string;
}

interface ExportSessionHeadCandidateRow extends SessionHeadCandidateRow {
  export_sequence: number;
}

export async function listSessionHeads(
  url: URL,
  env: Env,
  projectId: string,
  requestId: string,
): Promise<Response> {
  const parsed = parseSessionListQuery(url.searchParams);
  if (!parsed.ok) return jsonError(parsed.error, 400);
  const controls = parseSessionHeadControls(url.searchParams);
  if (!controls.ok) return jsonError(controls.error, 400);

  if (!provisionalRowsAreUseful(parsed.options)) {
    return jsonResponse({ sessions: [] }, { headers: NO_STORE_HEADERS });
  }

  const now = Date.now();
  let visiblePresence: PresenceSessionHead[] = [];
  if (provisionalRowsAreUseful(parsed.options)) {
    const presenceResult = await listProjectSessionHeads(
      env,
      projectId,
      requestId,
      buildPresenceHeadQuery(parsed.options, now, controls.value.trackedSessionIds),
    );
    if (presenceResult === null) return jsonError("presence_unavailable", 503);
    visiblePresence = presenceResult.sessions.filter((row) =>
      provisionalRowMatches(row, parsed.options),
    );
  }
  const deletedIds = await readDeletedSessionIds(
    env,
    projectId,
    visiblePresence.map((row) => row.session_id),
  );
  const projectOrgId = visiblePresence.some((row) => !row.org_id)
    ? await readProjectOrgId(env, projectId)
    : null;
  const provisional = visiblePresence
    .filter((row) => !deletedIds.has(row.session_id))
    .flatMap((row) => {
      const orgId = row.org_id || projectOrgId;
      return orgId === null ? [] : [provisionalHead(projectId, row, orgId)];
    });
  const exact = await readExactHeads(env, projectId, parsed.options, controls.value);

  const bySession = new Map<string, SessionHead>();
  for (const row of provisional) bySession.set(row.session_id, row);
  // Exact D1 metadata wins during the short overlap with the presence row.
  for (const row of exact) bySession.set(row.session_id, exactHead(row));

  const sessions = limitSessionHeads(
    [...bySession.values()].toSorted(sessionHeadComparator(parsed.options.sort)),
    parsed.options.limit,
    controls.value.trackedSessionIds,
  );
  return jsonResponse({ sessions }, { headers: NO_STORE_HEADERS });
}

export async function getSessionState(
  env: Env,
  projectId: string,
  sessionId: string,
  requestId: string,
): Promise<Response> {
  if (await sessionHasDeletionFence(env, projectId, sessionId)) {
    return jsonError("not_found", 404);
  }

  const exact = await readExactSession(env, projectId, sessionId);
  if (exact !== null) {
    return jsonResponse(exactHead(exact), { headers: NO_STORE_HEADERS });
  }

  const now = Date.now();
  const presence = await readProjectSessionHead(env, projectId, sessionId, requestId, now);
  if (presence !== null) {
    const orgId = presence.org_id || (await readProjectOrgId(env, projectId));
    if (orgId === null) return jsonError("not_found", 404);
    let head = provisionalHead(projectId, presence, orgId);
    // A delayed best-effort presence marker must not make an already written
    // final manifest look live again.
    if (
      head.activity !== "live" &&
      (await env.RECORDINGS.head(manifestKey(projectId, sessionId))) !== null
    ) {
      head = { ...head, activity: "finalizing", replay_source: "recorded" };
    }
    return jsonResponse(head, { headers: NO_STORE_HEADERS });
  }

  const manifestObject = await env.RECORDINGS.get(manifestKey(projectId, sessionId));
  if (manifestObject === null) return jsonError("not_found", 404);
  const manifest = sessionManifestSchema.safeParse(await manifestObject.json<unknown>());
  if (!manifest.success) return jsonError("not_found", 404);
  return jsonResponse(manifestHead(manifest.data), { headers: NO_STORE_HEADERS });
}

function provisionalHead(projectId: string, row: PresenceSessionHead, orgId: string): SessionHead {
  return {
    session_id: row.session_id,
    project_id: projectId,
    org_id: orgId,
    started_at: row.started_at,
    ended_at: row.last_seen,
    duration_ms: Math.max(0, row.last_seen - row.started_at),
    country: row.country,
    region: row.region ?? null,
    city: row.city,
    device: row.device,
    browser: row.browser,
    os: row.os,
    entry_url: row.entry_url,
    url_count: 0,
    page_count: null,
    analytics_version: 0,
    max_scroll_depth: null,
    quick_backs: null,
    interaction_time_ms: null,
    activity_hist: null,
    clicks: 0,
    errors: 0,
    rages: 0,
    navs: 0,
    bytes: 0,
    segment_count: 0,
    flags: row.flags ?? 0,
    manifest_key: manifestKey(projectId, row.session_id),
    expires_at: row.last_seen + CLOSE_SESSION_AFTER_IDLE_MS + SESSION_HEAD_HANDOFF_GRACE_MS,
    activity: row.activity,
    details_state: "provisional",
    replay_source: row.activity === "finalizing" ? "recorded" : "live",
  };
}

function exactHead(row: SessionRow): SessionHead {
  return {
    ...row,
    activity: "complete",
    details_state: "exact",
    replay_source: "recorded",
  };
}

function manifestHead(manifest: SessionManifest): SessionHead {
  return {
    session_id: manifest.sessionId,
    project_id: manifest.projectId,
    org_id: manifest.orgId,
    started_at: manifest.startedAt,
    ended_at: manifest.endedAt,
    duration_ms: manifest.durationMs,
    country: manifest.attrs.country ?? null,
    region: manifest.attrs.region ?? null,
    city: manifest.attrs.city ?? null,
    device: manifest.attrs.device ?? null,
    browser: manifest.attrs.browser ?? null,
    os: manifest.attrs.os ?? null,
    entry_url: manifest.attrs.entryUrl ?? null,
    url_count: manifest.attrs.urlCount ?? 0,
    page_count: manifest.attrs.pageCount ?? null,
    analytics_version: 0,
    max_scroll_depth: null,
    quick_backs: null,
    interaction_time_ms: null,
    activity_hist: null,
    clicks: manifest.counts.clicks,
    errors: manifest.counts.errors,
    rages: manifest.counts.rages,
    navs: manifest.counts.navs,
    bytes: manifest.bytes,
    segment_count: manifest.segments.length,
    flags: manifest.flags,
    manifest_key: manifestKey(manifest.projectId, manifest.sessionId),
    expires_at: manifest.endedAt,
    activity: "finalizing",
    details_state: "provisional",
    replay_source: "recorded",
  };
}

async function readExactSession(
  env: Env,
  projectId: string,
  sessionId: string,
): Promise<SessionRow | null> {
  return await shardDb(env, 0)
    .prepare(
      `SELECT ${sessionRowColumns.join(", ")}
      FROM sessions
      WHERE project_id = ? AND session_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM session_deletions d
          WHERE d.project_id = sessions.project_id AND d.session_id = sessions.session_id
        )
      LIMIT 1`,
    )
    .bind(projectId, sessionId)
    .first<SessionRow>();
}

async function readExactHeads(
  env: Env,
  projectId: string,
  options: SessionListOptions,
  controls: SessionHeadControls,
): Promise<SessionRow[]> {
  const candidateIds = await readExactHeadCandidateIds(env, projectId, options, controls);
  if (candidateIds.length === 0) return [];

  const query = buildExactSessionHeadQuery(projectId, options, candidateIds);
  const result = await shardDb(env, 0)
    .prepare(query.sql)
    .bind(...query.bindings)
    .all<SessionRow>();
  return result.results ?? [];
}

async function readExactHeadCandidateIds(
  env: Env,
  projectId: string,
  options: SessionListOptions,
  controls: SessionHeadControls,
): Promise<string[]> {
  const db = shardDb(env, 0);
  const exportPromise =
    options.warehouse_version === undefined
      ? Promise.resolve([])
      : readExportCandidateIds(db, projectId, options.warehouse_version);
  const startedPromise =
    controls.warehouseTo === undefined
      ? Promise.resolve([])
      : db
          .prepare(sessionHeadCandidateSql.started)
          .bind(projectId, controls.warehouseTo, SESSION_HEAD_CANDIDATE_LIMIT)
          .all<SessionHeadCandidateRow>()
          .then((result) => (result.results ?? []).map((row) => row.session_id));
  const indexedPromise = (
    options.warehouse_version === undefined
      ? db
          .prepare(sessionHeadCandidateSql.latestIndexed)
          .bind(projectId, SESSION_HEAD_CANDIDATE_LIMIT)
      : db
          .prepare(sessionHeadCandidateSql.indexed)
          .bind(projectId, controls.openedAt, SESSION_HEAD_CANDIDATE_LIMIT)
  )
    .all<SessionHeadCandidateRow>()
    .then((result) => (result.results ?? []).map((row) => row.session_id));

  const [exportIds, startedIds, indexedIds] = await Promise.all([
    exportPromise,
    startedPromise,
    indexedPromise,
  ]);
  return [...new Set([...controls.trackedSessionIds, ...exportIds, ...startedIds, ...indexedIds])];
}

async function readExportCandidateIds(
  db: D1Database,
  projectId: string,
  warehouseVersion: number,
): Promise<string[]> {
  const [outbox, ledger] = await Promise.all([
    db
      .prepare(sessionHeadCandidateSql.outbox)
      .bind(projectId, warehouseVersion, SESSION_HEAD_CANDIDATE_LIMIT)
      .all<ExportSessionHeadCandidateRow>(),
    db
      .prepare(sessionHeadCandidateSql.ledger)
      .bind(projectId, warehouseVersion, SESSION_HEAD_CANDIDATE_LIMIT)
      .all<ExportSessionHeadCandidateRow>(),
  ]);
  const candidates = [...(outbox.results ?? []), ...(ledger.results ?? [])].toSorted(
    (left, right) =>
      right.export_sequence - left.export_sequence ||
      right.session_id.localeCompare(left.session_id),
  );
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.session_id)) continue;
    seen.add(candidate.session_id);
    ids.push(candidate.session_id);
    if (ids.length === SESSION_HEAD_CANDIDATE_LIMIT) break;
  }
  return ids;
}

export function buildExactSessionHeadQuery(
  projectId: string,
  options: SessionListOptions,
  candidateIds: readonly string[],
): { sql: string; bindings: Array<string | number> } {
  const filter: SessionFilter = { ...options, warehouse_version: undefined };
  const where = buildSessionWhere(projectId, filter, options.before, "s");
  return {
    sql: `WITH candidate_ids(session_id) AS (
      SELECT CAST(value AS TEXT) FROM json_each(?)
    )
    SELECT ${sessionRowColumns.map((column) => `s.${column}`).join(", ")}
    FROM candidate_ids c
    CROSS JOIN sessions AS s INDEXED BY sqlite_autoindex_sessions_1
    WHERE s.session_id = c.session_id AND ${where.sql}`,
    bindings: [JSON.stringify(candidateIds), ...where.bindings],
  };
}

function parseSessionHeadControls(
  params: URLSearchParams,
): { ok: true; value: SessionHeadControls } | { ok: false; error: string } {
  const openedAt = parseSingleEpochControl(params, "opened_at", true);
  if (!openedAt.ok) return openedAt;
  const warehouseTo = parseSingleEpochControl(params, "warehouse_to", false);
  if (!warehouseTo.ok) return warehouseTo;
  if (warehouseTo.value !== undefined && warehouseTo.value > openedAt.value) {
    return { ok: false, error: "invalid_warehouse_to" };
  }

  const trackedValues = params.getAll("tracked_session_id");
  if (trackedValues.length > SESSION_HEAD_CANDIDATE_LIMIT) {
    return { ok: false, error: "too_many_tracked_session_ids" };
  }
  if (trackedValues.some((sessionId) => !isValidPathId(sessionId))) {
    return { ok: false, error: "invalid_tracked_session_id" };
  }

  return {
    ok: true,
    value: {
      openedAt: openedAt.value,
      ...(warehouseTo.value === undefined ? {} : { warehouseTo: warehouseTo.value }),
      trackedSessionIds: [...new Set(trackedValues)],
    },
  };
}

function parseSingleEpochControl(
  params: URLSearchParams,
  name: "opened_at" | "warehouse_to",
  required: true,
): { ok: true; value: number } | { ok: false; error: string };
function parseSingleEpochControl(
  params: URLSearchParams,
  name: "opened_at" | "warehouse_to",
  required: false,
): { ok: true; value: number | undefined } | { ok: false; error: string };
function parseSingleEpochControl(
  params: URLSearchParams,
  name: "opened_at" | "warehouse_to",
  required: boolean,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const values = params.getAll(name);
  if (values.length === 0 && !required) return { ok: true, value: undefined };
  if (values.length !== 1 || !/^(0|[1-9]\d*)$/.test(values[0] ?? "")) {
    return { ok: false, error: `invalid_${name}` };
  }
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value)) return { ok: false, error: `invalid_${name}` };
  return { ok: true, value };
}

function provisionalRowsAreUseful(options: SessionListOptions): boolean {
  if (options.sort !== "newest" && options.sort !== "duration") return false;
  return !hasExactOnlyFilter(options);
}

function buildPresenceHeadQuery(
  options: SessionListOptions,
  now: number,
  trackedSessionIds: string[],
): PresenceHeadQuery {
  const sort = options.sort === "duration" ? "duration" : "newest";
  const before =
    options.before !== undefined && typeof options.before.sortValue === "number"
      ? {
          sortValue: options.before.sortValue,
          ...(options.before.sessionId === undefined
            ? {}
            : { sessionId: options.before.sessionId }),
        }
      : undefined;

  return {
    now,
    limit: options.limit,
    sort,
    ...(trackedSessionIds.length === 0 ? {} : { trackedSessionIds }),
    ...(before === undefined ? {} : { before }),
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
    ...(options.country === undefined ? {} : { country: options.country }),
    ...(options.region === undefined ? {} : { region: options.region }),
    ...(options.device === undefined ? {} : { device: options.device }),
    ...(options.browser === undefined ? {} : { browser: options.browser }),
    ...(options.os === undefined ? {} : { os: options.os }),
    ...(options.entry_url === undefined ? {} : { entryUrl: options.entry_url }),
    ...(options.entry_url_prefix === undefined ? {} : { entryUrlPrefix: options.entry_url_prefix }),
    ...(options.min_duration_ms === undefined ? {} : { minDurationMs: options.min_duration_ms }),
  };
}

function limitSessionHeads(
  sortedSessions: SessionHead[],
  requestedLimit: number,
  trackedSessionIds: readonly string[],
): SessionHead[] {
  const keptSessionIds = new Set(
    sortedSessions.slice(0, requestedLimit).map((session) => session.session_id),
  );
  const tracked = new Set(trackedSessionIds);
  for (const session of sortedSessions) {
    if (tracked.has(session.session_id)) keptSessionIds.add(session.session_id);
  }
  return sortedSessions
    .filter((session) => keptSessionIds.has(session.session_id))
    .slice(0, SESSION_HEAD_RESPONSE_LIMIT);
}

function hasExactOnlyFilter(filter: SessionFilter): boolean {
  return (
    filter.has_errors !== undefined ||
    filter.error_detail !== undefined ||
    filter.has_page_coverage !== undefined ||
    filter.has_rage !== undefined ||
    filter.has_quick_back !== undefined ||
    filter.has_insights !== undefined
  );
}

function provisionalRowMatches(row: PresenceSessionHead, options: SessionListOptions): boolean {
  if (options.from !== undefined && row.started_at < options.from) return false;
  if (options.to !== undefined && row.started_at > options.to) return false;
  if (options.country !== undefined && row.country !== options.country) return false;
  if (options.region !== undefined && row.region !== options.region) return false;
  if (options.device !== undefined && row.device !== options.device) return false;
  if (options.browser !== undefined && row.browser !== options.browser) return false;
  if (options.os !== undefined && row.os !== options.os) return false;
  if (options.entry_url !== undefined && row.entry_url !== options.entry_url) return false;
  if (
    options.entry_url_prefix !== undefined &&
    (row.entry_url === null || !row.entry_url.startsWith(options.entry_url_prefix))
  ) {
    return false;
  }
  if (
    options.min_duration_ms !== undefined &&
    Math.max(0, row.last_seen - row.started_at) < options.min_duration_ms
  ) {
    return false;
  }
  return provisionalRowIsBefore(row, options);
}

function provisionalRowIsBefore(row: PresenceSessionHead, options: SessionListOptions): boolean {
  const before = options.before;
  if (before === undefined) return true;
  if (typeof before.sortValue !== "number") return false;
  const value =
    options.sort === "duration" ? Math.max(0, row.last_seen - row.started_at) : row.started_at;
  if (value < before.sortValue) return true;
  return value === before.sortValue && row.session_id < (before.sessionId ?? "\uffff");
}

function sessionHeadComparator(
  sort: SessionSort,
): (left: SessionHead, right: SessionHead) => number {
  return (left, right) => {
    const leftValue = sortValue(left, sort);
    const rightValue = sortValue(right, sort);
    if (leftValue === null && rightValue !== null) return 1;
    if (leftValue !== null && rightValue === null) return -1;
    if (leftValue !== rightValue) return (rightValue ?? 0) - (leftValue ?? 0);
    return right.session_id.localeCompare(left.session_id);
  };
}

function sortValue(row: SessionHead, sort: SessionSort): number | null {
  if (sort === "newest") return row.started_at;
  if (sort === "duration") return row.duration_ms;
  if (sort === "clicks") return row.clicks;
  if (sort === "pages") return row.page_count;
  return row.errors * 1000 + row.rages * 100 + row.clicks;
}

async function readDeletedSessionIds(
  env: Env,
  projectId: string,
  sessionIds: readonly string[],
): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const result = await shardDb(env, 0)
    .prepare(
      `SELECT session_id
      FROM session_deletions
      WHERE project_id = ? AND session_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(projectId, JSON.stringify(sessionIds))
    .all<{ session_id: string }>();
  return new Set((result.results ?? []).map((row) => row.session_id));
}

async function readProjectOrgId(env: Env, projectId: string): Promise<string | null> {
  const row = await shardDb(env, 0)
    .prepare("SELECT org_id FROM projects WHERE id = ? LIMIT 1")
    .bind(projectId)
    .first<{ org_id: string }>();
  return row?.org_id ?? null;
}

export async function sessionHasDeletionFence(
  env: Env,
  projectId: string,
  sessionId: string,
): Promise<boolean> {
  const row = await shardDb(env, 0)
    .prepare(
      `SELECT 1 AS found
      FROM session_deletions
      WHERE project_id = ? AND session_id = ?
      LIMIT 1`,
    )
    .bind(projectId, sessionId)
    .first<{ found: number }>();
  return row !== null;
}
