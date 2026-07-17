import {
  MAX_PUBLIC_PAGE_RECORDINGS,
  MAX_PUBLIC_PAGE_SETTINGS_BODY_BYTES,
  type PublicPageSelectedRecording,
  type PublicPageSettings,
  type PublicPageSettingsUpdate,
  startWideEvent,
} from "@orange-replay/shared";
import type { Env } from "../env.ts";
import { isValidPathId } from "./helpers.ts";
import { jsonError, jsonResponse, readJsonBodyCapped } from "./http.ts";

interface PublicPageRow {
  [key: string]: unknown;
  public_id: string;
  is_enabled: number;
  revision: number;
}

interface SelectedRecordingRow {
  [key: string]: unknown;
  session_id: string;
  public_replay_id: string;
  position: number;
  started_at: number;
  duration_ms: number;
  entry_url: string | null;
  country: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  clicks: number;
  errors: number;
  rages: number;
  page_count: number | null;
}

type PublicOriginResult = { ok: true; origin: string } | { ok: false; response: Response };

export async function getPublicPageSettings(
  requestUrl: URL,
  env: Env,
  projectId: string,
): Promise<Response> {
  if (!(await projectExists(env.IDX_00, projectId))) return jsonError("not_found", 404);

  const origin = readPublicPageOrigin(requestUrl, env);
  if (!origin.ok) return origin.response;

  const settings = await readPublicPageSettings(env.IDX_00, projectId, origin.origin);
  return jsonResponse(settings, { headers: { "cache-control": "private, no-store" } });
}

export async function putPublicPageSettings(
  request: Request,
  requestUrl: URL,
  env: Env,
  projectId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  const body = await readJsonBodyCapped(request, MAX_PUBLIC_PAGE_SETTINGS_BODY_BYTES);
  if (!body.ok) return jsonError(body.error, body.status);

  const update = parsePublicPageSettingsUpdate(body.value);
  if (!update.ok) return jsonError(update.error, 400);
  if (!(await projectExists(env.IDX_00, projectId))) return jsonError("not_found", 404);

  const origin = readPublicPageOrigin(requestUrl, env);
  if (!origin.ok) return origin.response;

  const selectedRows = await readValidSelectedRecordings(
    env.IDX_00,
    projectId,
    update.value.sessionIds,
  );
  if (selectedRows === null) return jsonError("recording_not_available", 400);

  const currentReplayIds = await readCurrentReplayIds(env.IDX_00, projectId);
  const now = Date.now();
  const publicId = makeRandomPathId("pub");
  const mutationToken = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];

  if (update.value.expectedRevision === 0) {
    statements.push(
      env.IDX_00.prepare(
        `INSERT INTO project_public_pages (
          project_id, public_id, is_enabled, revision, published_at, updated_at, mutation_token
        ) VALUES (?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(project_id) DO NOTHING`,
      ).bind(
        projectId,
        publicId,
        update.value.enabled ? 1 : 0,
        update.value.enabled ? now : null,
        now,
        mutationToken,
      ),
    );
  } else {
    statements.push(
      env.IDX_00.prepare(
        `UPDATE project_public_pages
          SET is_enabled = ?,
              revision = revision + 1,
              published_at = CASE
                WHEN ? = 1 AND published_at IS NULL THEN ?
                ELSE published_at
              END,
              updated_at = ?,
              mutation_token = ?
          WHERE project_id = ?
            AND revision = ?`,
      ).bind(
        update.value.enabled ? 1 : 0,
        update.value.enabled ? 1 : 0,
        now,
        now,
        mutationToken,
        projectId,
        update.value.expectedRevision,
      ),
    );
  }

  statements.push(
    env.IDX_00.prepare(
      `DELETE FROM public_page_sessions
        WHERE project_id = ?
          AND EXISTS (
            SELECT 1
            FROM project_public_pages
            WHERE project_id = ?
              AND mutation_token = ?
          )`,
    ).bind(projectId, projectId, mutationToken),
  );
  for (const [position, sessionId] of update.value.sessionIds.entries()) {
    statements.push(
      env.IDX_00.prepare(
        `INSERT INTO public_page_sessions (
          project_id, session_id, public_replay_id, position, added_at
        )
        SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1
          FROM project_public_pages
          WHERE project_id = ?
            AND mutation_token = ?
        )`,
      ).bind(
        projectId,
        sessionId,
        currentReplayIds.get(sessionId) ?? makeRandomPathId("replay"),
        position,
        now,
        projectId,
        mutationToken,
      ),
    );
  }

  const results = await env.IDX_00.batch(statements);
  if (results[0]?.meta.changes !== 1) {
    return jsonError("public_page_settings_changed", 409, {
      "cache-control": "private, no-store",
    });
  }
  const settings = await readPublicPageSettings(env.IDX_00, projectId, origin.origin);
  wideEvent.set({
    project_id: projectId,
    public_page_enabled: settings.enabled,
    public_recording_count: settings.recordings.length,
    public_page_revision: settings.revision,
  });
  return jsonResponse(settings, { headers: { "cache-control": "private, no-store" } });
}

export function readPublicPageOrigin(requestUrl: URL, env: Env): PublicOriginResult {
  const configured = env.PUBLIC_PAGE_ORIGIN?.trim();
  if (!configured) {
    if (env.WORKER_ENV?.trim().toLowerCase() === "production") {
      return { ok: false, response: jsonError("public_page_origin_not_set", 503) };
    }
    return { ok: true, origin: requestUrl.origin };
  }

  try {
    const url = new URL(configured);
    const isProduction = env.WORKER_ENV?.trim().toLowerCase() === "production";
    if (
      (isProduction
        ? url.protocol !== "https:"
        : url.protocol !== "https:" && url.protocol !== "http:") ||
      (isProduction && url.port !== "") ||
      url.username !== "" ||
      url.password !== "" ||
      url.hostname.length === 0 ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return { ok: false, response: jsonError("public_page_origin_invalid", 503) };
    }
    return { ok: true, origin: url.origin };
  } catch {
    return { ok: false, response: jsonError("public_page_origin_invalid", 503) };
  }
}

export function publicPageUrl(origin: string, publicId: string): string {
  return `${origin}/p/${encodeURIComponent(publicId)}`;
}

async function readPublicPageSettings(
  database: D1Database,
  projectId: string,
  origin: string,
): Promise<PublicPageSettings> {
  const [page, recordings] = await Promise.all([
    readPublicPageRow(database, projectId),
    readSelectedRecordings(database, projectId),
  ]);
  if (page === null) {
    return { enabled: false, publicId: null, publicUrl: null, revision: 0, recordings: [] };
  }
  return {
    enabled: page.is_enabled === 1,
    publicId: page.public_id,
    publicUrl: publicPageUrl(origin, page.public_id),
    revision: page.revision,
    recordings,
  };
}

async function projectExists(database: D1Database, projectId: string): Promise<boolean> {
  return (
    (await database
      .prepare("SELECT 1 FROM projects WHERE id = ? LIMIT 1")
      .bind(projectId)
      .first()) !== null
  );
}

async function readPublicPageRow(
  database: D1Database,
  projectId: string,
): Promise<PublicPageRow | null> {
  return database
    .prepare(
      `SELECT public_id, is_enabled, revision
        FROM project_public_pages
        WHERE project_id = ?
        LIMIT 1`,
    )
    .bind(projectId)
    .first<PublicPageRow>();
}

async function readCurrentReplayIds(
  database: D1Database,
  projectId: string,
): Promise<Map<string, string>> {
  const result = await database
    .prepare(
      `SELECT session_id, public_replay_id
        FROM public_page_sessions
        WHERE project_id = ?`,
    )
    .bind(projectId)
    .all<{ session_id: string; public_replay_id: string }>();
  return new Map((result.results ?? []).map((row) => [row.session_id, row.public_replay_id]));
}

async function readValidSelectedRecordings(
  database: D1Database,
  projectId: string,
  sessionIds: string[],
): Promise<SelectedRecordingRow[] | null> {
  if (sessionIds.length === 0) return [];
  const placeholders = sessionIds.map(() => "?").join(", ");
  const result = await database
    .prepare(
      `SELECT ${selectedRecordingColumns("s")}
        FROM sessions s
        WHERE s.project_id = ?
          AND s.session_id IN (${placeholders})
          AND NOT EXISTS (
            SELECT 1
            FROM session_deletions d
            WHERE d.project_id = s.project_id
              AND d.session_id = s.session_id
          )`,
    )
    .bind(projectId, ...sessionIds)
    .all<SelectedRecordingRow>();
  const rows = result.results ?? [];
  return rows.length === sessionIds.length ? rows : null;
}

async function readSelectedRecordings(
  database: D1Database,
  projectId: string,
): Promise<PublicPageSelectedRecording[]> {
  const result = await database
    .prepare(
      `SELECT p.session_id, p.public_replay_id, p.position, ${selectedRecordingColumns("s", false)}
        FROM public_page_sessions p
        INNER JOIN sessions s
          ON s.project_id = p.project_id
         AND s.session_id = p.session_id
        WHERE p.project_id = ?
          AND NOT EXISTS (
            SELECT 1
            FROM session_deletions d
            WHERE d.project_id = p.project_id
              AND d.session_id = p.session_id
          )
        ORDER BY p.position ASC`,
    )
    .bind(projectId)
    .all<SelectedRecordingRow>();
  return (result.results ?? []).map(toSelectedRecording);
}

function selectedRecordingColumns(alias: string, includeSessionId = true): string {
  return [
    ...(includeSessionId ? [`${alias}.session_id`] : []),
    `${alias}.started_at`,
    `${alias}.duration_ms`,
    `${alias}.entry_url`,
    `${alias}.country`,
    `${alias}.device`,
    `${alias}.browser`,
    `${alias}.os`,
    `${alias}.clicks`,
    `${alias}.errors`,
    `${alias}.rages`,
    `${alias}.page_count`,
  ].join(", ");
}

function toSelectedRecording(row: SelectedRecordingRow): PublicPageSelectedRecording {
  return {
    sessionId: row.session_id,
    replayId: row.public_replay_id,
    position: row.position,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    entryPath: safeEntryPath(row.entry_url),
    country: row.country,
    device: row.device,
    browser: row.browser,
    operatingSystem: row.os,
    clicks: row.clicks,
    errors: row.errors,
    rages: row.rages,
    pages: row.page_count,
  };
}

function safeEntryPath(value: string | null): string {
  if (!value) return "/";
  try {
    const parsed = new URL(value, "https://public.invalid");
    return parsed.pathname || "/";
  } catch {
    return "/";
  }
}

function parsePublicPageSettingsUpdate(
  value: unknown,
): { ok: true; value: PublicPageSettingsUpdate } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "invalid_public_page_settings" };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "enabled" ||
    keys[1] !== "expectedRevision" ||
    keys[2] !== "sessionIds"
  ) {
    return { ok: false, error: "invalid_public_page_settings" };
  }
  if (
    typeof record.enabled !== "boolean" ||
    !Number.isSafeInteger(record.expectedRevision) ||
    (record.expectedRevision as number) < 0 ||
    !Array.isArray(record.sessionIds)
  ) {
    return { ok: false, error: "invalid_public_page_settings" };
  }
  if (record.sessionIds.length > MAX_PUBLIC_PAGE_RECORDINGS) {
    return { ok: false, error: "too_many_public_recordings" };
  }
  if (!record.sessionIds.every((sessionId) => typeof sessionId === "string")) {
    return { ok: false, error: "invalid_recording_id" };
  }
  const sessionIds = record.sessionIds as string[];
  if (!sessionIds.every(isValidPathId)) {
    return { ok: false, error: "invalid_recording_id" };
  }
  if (new Set(sessionIds).size !== sessionIds.length) {
    return { ok: false, error: "duplicate_recording_id" };
  }
  return {
    ok: true,
    value: {
      enabled: record.enabled,
      expectedRevision: record.expectedRevision as number,
      sessionIds,
    },
  };
}

function makeRandomPathId(prefix: "pub" | "replay"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return `${prefix}_${value}`;
}
