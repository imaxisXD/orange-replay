import { manifestKey, sessionPrefix, type SessionManifest } from "@orange-replay/shared";
import {
  isValidPathId,
  isValidSegmentName,
  sessionRowColumns,
  type SessionColumn,
  type SessionRow,
} from "../api/helpers.ts";
import type { Env } from "../env.ts";
import { createTestDatabaseSchema } from "./database-schema.ts";

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

  await createTestDatabaseSchema(env.IDX_00);

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
