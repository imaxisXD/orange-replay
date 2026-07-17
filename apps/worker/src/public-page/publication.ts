import type {
  PublicPageRecording,
  PublicPageSelectedRecording,
  PublicPageSettings,
  PublicPageSettingsUpdate,
} from "@orange-replay/shared";
import { safePublicEntryPath } from "@orange-replay/shared/analytics-privacy";
import type { Env } from "../env.ts";

interface PublicationPageRow {
  [key: string]: unknown;
  public_id: string;
  is_enabled: number;
  revision: number;
}

interface PublishedProjectRow {
  [key: string]: unknown;
  project_id: string;
  public_id: string;
  project_name: string;
}

interface PublicationRecordingRow {
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

export interface PublishedProject {
  projectId: string;
  publicId: string;
  projectName: string;
}

export interface PublishedReplaySource {
  projectId: string;
  sessionId: string;
}

export type PublicationSettingsReadResult =
  | { ok: true; settings: PublicPageSettings }
  | {
      ok: false;
      error: "not_found" | "public_page_origin_not_set" | "public_page_origin_invalid";
    };

export type PublicationSettingsWriteResult =
  | { ok: true; settings: PublicPageSettings }
  | {
      ok: false;
      error:
        | "not_found"
        | "public_page_origin_not_set"
        | "public_page_origin_invalid"
        | "recording_not_available"
        | "public_page_settings_changed";
    };

export type PublicPageOriginResult =
  | { ok: true; origin: string }
  | { ok: false; error: "public_page_origin_not_set" | "public_page_origin_invalid" };

const publishedPageCte = `WITH published_page AS (
  SELECT page.project_id, page.public_id, project.name AS project_name
  FROM project_public_pages page
  INNER JOIN projects project ON project.id = page.project_id
  WHERE page.public_id = ?
    AND page.is_enabled = 1
  LIMIT 1
)`;

const availableSessionPredicate = `NOT EXISTS (
  SELECT 1
  FROM session_deletions deletion
  WHERE deletion.project_id = session.project_id
    AND deletion.session_id = session.session_id
)`;

/**
 * Owns the D1 publication state and every rule that decides whether a curated
 * recording is still available. HTTP routes only translate these results.
 */
export async function readPublicationSettings(
  database: D1Database,
  projectId: string,
  requestUrl: URL,
  env: Env,
): Promise<PublicationSettingsReadResult> {
  if (!(await projectExists(database, projectId))) return { ok: false, error: "not_found" };

  const origin = resolvePublicPageOrigin(requestUrl, env);
  if (!origin.ok) return origin;

  return {
    ok: true,
    settings: await readPublicationSettingsRows(database, projectId, origin.origin),
  };
}

async function readPublicationSettingsRows(
  database: D1Database,
  projectId: string,
  origin: string,
): Promise<PublicPageSettings> {
  const [page, recordings] = await Promise.all([
    readPublicationPageRow(database, projectId),
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

export async function replacePublicationSettings(
  database: D1Database,
  projectId: string,
  requestUrl: URL,
  env: Env,
  update: PublicPageSettingsUpdate,
): Promise<PublicationSettingsWriteResult> {
  if (!(await projectExists(database, projectId))) return { ok: false, error: "not_found" };

  const origin = resolvePublicPageOrigin(requestUrl, env);
  if (!origin.ok) return origin;

  if (!(await selectedRecordingsAreAvailable(database, projectId, update.sessionIds))) {
    return { ok: false, error: "recording_not_available" };
  }

  const currentReplayIds = await readCurrentReplayIds(database, projectId);
  const now = Date.now();
  const publicId = makeRandomPathId("pub");
  const mutationToken = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];

  if (update.expectedRevision === 0) {
    statements.push(
      database
        .prepare(
          `INSERT INTO project_public_pages (
            project_id, public_id, is_enabled, revision, published_at, updated_at, mutation_token
          ) VALUES (?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(project_id) DO NOTHING`,
        )
        .bind(
          projectId,
          publicId,
          update.enabled ? 1 : 0,
          update.enabled ? now : null,
          now,
          mutationToken,
        ),
    );
  } else {
    statements.push(
      database
        .prepare(
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
        )
        .bind(
          update.enabled ? 1 : 0,
          update.enabled ? 1 : 0,
          now,
          now,
          mutationToken,
          projectId,
          update.expectedRevision,
        ),
    );
  }

  statements.push(
    database
      .prepare(
        `DELETE FROM public_page_sessions
          WHERE project_id = ?
            AND EXISTS (
              SELECT 1
              FROM project_public_pages
              WHERE project_id = ?
                AND mutation_token = ?
            )`,
      )
      .bind(projectId, projectId, mutationToken),
  );
  for (const [position, sessionId] of update.sessionIds.entries()) {
    statements.push(
      database
        .prepare(
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
        )
        .bind(
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

  const results = await database.batch(statements);
  if (results[0]?.meta.changes !== 1) {
    return { ok: false, error: "public_page_settings_changed" };
  }

  const settings = await readPublicationSettingsRows(database, projectId, origin.origin);
  return { ok: true, settings };
}

export async function readPublishedProject(
  database: D1Database,
  publicId: string,
): Promise<PublishedProject | null> {
  const row = await database
    .prepare(
      `${publishedPageCte}
      SELECT project_id, public_id, project_name
      FROM published_page`,
    )
    .bind(publicId)
    .first<PublishedProjectRow>();
  return row === null
    ? null
    : { projectId: row.project_id, publicId: row.public_id, projectName: row.project_name };
}

export async function readPublishedRecordings(
  database: D1Database,
  publicId: string,
): Promise<PublicPageRecording[]> {
  const result = await database
    .prepare(
      `${publishedPageCte}
      SELECT selection.session_id, selection.public_replay_id, selection.position,
             ${recordingSummaryColumns}
      FROM published_page page
      INNER JOIN public_page_sessions selection ON selection.project_id = page.project_id
      INNER JOIN sessions session
        ON session.project_id = selection.project_id
       AND session.session_id = selection.session_id
      WHERE ${availableSessionPredicate}
      ORDER BY selection.position ASC`,
    )
    .bind(publicId)
    .all<PublicationRecordingRow>();
  return (result.results ?? []).map(toPublicRecording);
}

export async function readPublishedReplaySource(
  database: D1Database,
  publicId: string,
  publicReplayId: string,
): Promise<PublishedReplaySource | null> {
  const row = await database
    .prepare(
      `${publishedPageCte}
      SELECT page.project_id, selection.session_id
      FROM published_page page
      INNER JOIN public_page_sessions selection ON selection.project_id = page.project_id
      INNER JOIN sessions session
        ON session.project_id = selection.project_id
       AND session.session_id = selection.session_id
      WHERE selection.public_replay_id = ?
        AND ${availableSessionPredicate}
      LIMIT 1`,
    )
    .bind(publicId, publicReplayId)
    .first<{ project_id: string; session_id: string }>();
  return row === null ? null : { projectId: row.project_id, sessionId: row.session_id };
}

export function resolvePublicPageOrigin(requestUrl: URL, env: Env): PublicPageOriginResult {
  const configured = env.PUBLIC_PAGE_ORIGIN?.trim();
  if (!configured) {
    if (env.WORKER_ENV?.trim().toLowerCase() === "production") {
      return { ok: false, error: "public_page_origin_not_set" };
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
      return { ok: false, error: "public_page_origin_invalid" };
    }
    return { ok: true, origin: url.origin };
  } catch {
    return { ok: false, error: "public_page_origin_invalid" };
  }
}

export function publicPageUrl(origin: string, publicId: string): string {
  return `${origin}/p/${encodeURIComponent(publicId)}`;
}

const recordingSummaryColumns = [
  "session.started_at",
  "session.duration_ms",
  "session.entry_url",
  "session.country",
  "session.device",
  "session.browser",
  "session.os",
  "session.clicks",
  "session.errors",
  "session.rages",
  "session.page_count",
].join(", ");

async function projectExists(database: D1Database, projectId: string): Promise<boolean> {
  return (
    (await database
      .prepare("SELECT 1 FROM projects WHERE id = ? LIMIT 1")
      .bind(projectId)
      .first()) !== null
  );
}

async function readPublicationPageRow(
  database: D1Database,
  projectId: string,
): Promise<PublicationPageRow | null> {
  return database
    .prepare(
      `SELECT public_id, is_enabled, revision
      FROM project_public_pages
      WHERE project_id = ?
      LIMIT 1`,
    )
    .bind(projectId)
    .first<PublicationPageRow>();
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

async function selectedRecordingsAreAvailable(
  database: D1Database,
  projectId: string,
  sessionIds: string[],
): Promise<boolean> {
  if (sessionIds.length === 0) return true;
  const placeholders = sessionIds.map(() => "?").join(", ");
  const result = await database
    .prepare(
      `SELECT session.session_id
      FROM sessions session
      WHERE session.project_id = ?
        AND session.session_id IN (${placeholders})
        AND ${availableSessionPredicate}`,
    )
    .bind(projectId, ...sessionIds)
    .all<{ session_id: string }>();
  return (result.results ?? []).length === sessionIds.length;
}

async function readSelectedRecordings(
  database: D1Database,
  projectId: string,
): Promise<PublicPageSelectedRecording[]> {
  const result = await database
    .prepare(
      `SELECT selection.session_id, selection.public_replay_id, selection.position,
              ${recordingSummaryColumns}
      FROM public_page_sessions selection
      INNER JOIN sessions session
        ON session.project_id = selection.project_id
       AND session.session_id = selection.session_id
      WHERE selection.project_id = ?
        AND ${availableSessionPredicate}
      ORDER BY selection.position ASC`,
    )
    .bind(projectId)
    .all<PublicationRecordingRow>();
  return (result.results ?? []).map(toSelectedRecording);
}

function toPublicRecording(row: PublicationRecordingRow): PublicPageRecording {
  return {
    replayId: row.public_replay_id,
    position: row.position,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    entryPath: safePublicEntryPath(row.entry_url),
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

function toSelectedRecording(row: PublicationRecordingRow): PublicPageSelectedRecording {
  return { sessionId: row.session_id, ...toPublicRecording(row) };
}

function makeRandomPathId(prefix: "pub" | "replay"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return `${prefix}_${value}`;
}
