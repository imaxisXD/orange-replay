import { manifestKey, sessionPrefix, type SessionManifest } from "@orange-replay/shared";
import {
  isValidSegmentName,
  sessionRowColumns,
  type SessionColumn,
  type SessionRow,
} from "../api/helpers.ts";
import type { Env } from "../env.ts";

const schemaStatements = [
  "CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, shard INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, jurisdiction TEXT, retention_days INTEGER NOT NULL DEFAULT 30, sample_rate REAL NOT NULL DEFAULT 1.0, allowed_origins TEXT NOT NULL DEFAULT '[\"*\"]', mask_policy_version INTEGER NOT NULL DEFAULT 1, quota_state TEXT NOT NULL DEFAULT 'ok', created_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS keys (key_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, org_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, country TEXT, region TEXT, city TEXT, device TEXT, browser TEXT, os TEXT, entry_url TEXT, url_count INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, rages INTEGER NOT NULL DEFAULT 0, navs INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, segment_count INTEGER NOT NULL DEFAULT 0, flags INTEGER NOT NULL DEFAULT 0, manifest_key TEXT NOT NULL, expires_at INTEGER NOT NULL);",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_time ON sessions(project_id, started_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);",
  "CREATE TABLE IF NOT EXISTS session_events (session_id TEXT NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT, PRIMARY KEY (session_id, t, kind));",
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
    await env.IDX_00.exec(statement);
  }

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

  return { ok: true, row: row as SessionRow };
}

function bytesFromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
