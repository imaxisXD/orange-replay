import { manifestKey, sessionPrefix, type SessionManifest } from "@orange-replay/shared";
import {
  isValidPathId,
  isValidSegmentName,
  sessionRowColumns,
  type SessionColumn,
  type SessionRow,
} from "../api/helpers.ts";
import type { Env } from "../env.ts";

const schemaStatements = [
  "CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, shard INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);",
  'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, jurisdiction TEXT, retention_days INTEGER NOT NULL DEFAULT 30, sample_rate REAL NOT NULL DEFAULT 1.0, allowed_origins TEXT NOT NULL, mask_policy_version INTEGER NOT NULL DEFAULT 1, mask_rules TEXT NOT NULL DEFAULT \'[]\', capture_toggles TEXT NOT NULL DEFAULT \'{"heatmaps":false,"console":false,"network":false,"canvas":false}\', quota_state TEXT NOT NULL DEFAULT \'ok\', config_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);',
  "CREATE TABLE IF NOT EXISTS keys (key_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS sessions (session_id TEXT NOT NULL, project_id TEXT NOT NULL, org_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, country TEXT, region TEXT, city TEXT, device TEXT, browser TEXT, os TEXT, entry_url TEXT, url_count INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, rages INTEGER NOT NULL DEFAULT 0, navs INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, segment_count INTEGER NOT NULL DEFAULT 0, flags INTEGER NOT NULL DEFAULT 0, manifest_key TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (project_id, session_id));",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_time ON sessions(project_id, started_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);",
  "CREATE TABLE IF NOT EXISTS session_events (project_id TEXT NOT NULL, session_id TEXT NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT, PRIMARY KEY (project_id, session_id, t, kind));",
  "CREATE TABLE IF NOT EXISTS session_deletions (project_id TEXT NOT NULL, session_id TEXT NOT NULL, requested_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, PRIMARY KEY (project_id, session_id));",
  "CREATE TABLE IF NOT EXISTS usage_monthly (org_id TEXT NOT NULL, month TEXT NOT NULL, sessions INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (org_id, month));",
] as const;

interface SeedSegment {
  name: string;
  bytesB64: string;
}

interface SeedPayload {
  session: unknown;
  manifest: SessionManifest;
  segments: SeedSegment[];
}

export async function handleApiTestRoutes(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/__test/api/delete-session-row") {
    return deleteSessionRow(request, env);
  }

  if (request.method !== "POST" || url.pathname !== "/__test/api/seed") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  let payload: SeedPayload;
  try {
    payload = (await request.json()) as SeedPayload;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const session = readSessionRow(payload.session);
  if (!session.ok) {
    return Response.json({ error: session.error }, { status: 400 });
  }

  for (const segment of payload.segments) {
    if (!isValidSegmentName(segment.name)) {
      return Response.json({ error: "invalid_segment_name" }, { status: 400 });
    }
  }

  for (const statement of schemaStatements) {
    await env.IDX_00.prepare(statement).run();
  }

  await seedProjectForSession(env, session.row);

  const placeholders = sessionRowColumns.map(() => "?").join(", ");
  await env.IDX_00.prepare(
    `INSERT INTO sessions (${sessionRowColumns.join(", ")}) VALUES (${placeholders})`,
  )
    .bind(...sessionRowColumns.map((column) => session.row[column]))
    .run();

  await env.RECORDINGS.put(
    manifestKey(session.row.project_id, session.row.session_id),
    JSON.stringify(payload.manifest),
    { httpMetadata: { contentType: "application/json" } },
  );

  for (const segment of payload.segments) {
    await env.RECORDINGS.put(
      `${sessionPrefix(session.row.project_id, session.row.session_id)}/${segment.name}`,
      bytesFromBase64(segment.bytesB64),
      { httpMetadata: { contentType: "application/octet-stream" } },
    );
  }

  return Response.json({ ok: true });
}

async function deleteSessionRow(request: Request, env: Env): Promise<Response> {
  let body: { projectId?: unknown; sessionId?: unknown };
  try {
    body = (await request.json()) as { projectId?: unknown; sessionId?: unknown };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body.projectId !== "string" || typeof body.sessionId !== "string") {
    return Response.json({ error: "invalid_session_id" }, { status: 400 });
  }
  if (!isValidPathId(body.projectId) || !isValidPathId(body.sessionId)) {
    return Response.json({ error: "invalid_session_id" }, { status: 400 });
  }

  await env.IDX_00.prepare("DELETE FROM sessions WHERE project_id = ? AND session_id = ?")
    .bind(body.projectId, body.sessionId)
    .run();
  return Response.json({ ok: true });
}

async function seedProjectForSession(env: Env, session: SessionRow): Promise<void> {
  const now = Date.now();
  await env.IDX_00.prepare(
    "INSERT OR IGNORE INTO orgs (id, name, shard, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(session.org_id, session.org_id, 0, now)
    .run();

  await env.IDX_00.prepare(
    `INSERT OR IGNORE INTO projects
      (id, org_id, name, retention_days, sample_rate, allowed_origins, mask_policy_version, mask_rules, capture_toggles, quota_state, config_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      session.project_id,
      session.org_id,
      session.project_id,
      30,
      1,
      JSON.stringify(["*"]),
      1,
      JSON.stringify([]),
      JSON.stringify({ heatmaps: false, console: false, network: false, canvas: false }),
      "ok",
      1,
      now,
    )
    .run();
}

function readSessionRow(
  input: unknown,
): { ok: true; row: SessionRow } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "invalid_session" };
  }

  const source = input as Record<string, unknown>;
  const row: Partial<Record<SessionColumn, string | number | null>> = {};
  for (const column of sessionRowColumns) {
    const value = source[column];
    if (typeof value === "string" || typeof value === "number" || value === null) {
      row[column] = value;
      continue;
    }
    if (value === undefined) {
      return { ok: false, error: `missing_${column}` };
    }
    return { ok: false, error: `invalid_${column}` };
  }

  const session = row as SessionRow;
  if (!isValidPathId(session.project_id) || !isValidPathId(session.session_id)) {
    return { ok: false, error: "invalid_session_id" };
  }

  return { ok: true, row: session };
}

function bytesFromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
