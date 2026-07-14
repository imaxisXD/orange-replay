import { manifestKey, sessionPrefix, type SessionManifest } from "@orange-replay/shared";
import { bootstrapAccount } from "../api/account-routes.ts";
import { getAdminStats, getAdminUsers } from "../api/admin-routes.ts";
import type { SessionAuthContext } from "../api/auth.ts";
import {
  isValidPathId,
  isValidSegmentName,
  sessionRowColumns,
  type SessionColumn,
  type SessionRow,
} from "../api/helpers.ts";
import type { Env } from "../env.ts";
import { buildExactSessionHeadQuery, sessionHeadCandidateSql } from "../api/session-head-routes.ts";
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

interface AnalyticsBootstrapReceiptRow {
  [key: string]: unknown;
  completed_at: number;
  project_id: string;
  report_id: string;
  required_sequence: number;
  source_cutoff_ms: number;
  source_session_count: number;
}

export async function handleApiTestRoutes(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/__test/api/hosted/admin/stats") {
    return getAdminStats(env);
  }

  if (request.method === "GET" && url.pathname === "/__test/api/hosted/admin/users") {
    return getAdminUsers(url, env);
  }

  if (
    request.method === "GET" &&
    url.pathname === "/__test/api/hosted/analytics-bootstrap-receipt"
  ) {
    return readAnalyticsBootstrapReceipt(url, env);
  }

  if (request.method === "POST" && url.pathname === "/__test/api/delete-session-row") {
    return deleteSessionRow(request, env);
  }

  if (request.method === "POST" && url.pathname === "/__test/api/seed-session-export") {
    return seedSessionExport(request, env);
  }

  if (request.method === "POST" && url.pathname === "/__test/api/mark-session-indexed") {
    return markSessionIndexed(request, env);
  }

  if (request.method === "POST" && url.pathname === "/__test/api/seed-session-head-noise") {
    return seedSessionHeadNoise(request, env);
  }

  if (request.method === "GET" && url.pathname === "/__test/api/session-head-plan") {
    const projectId = url.searchParams.get("projectId") ?? "";
    const source = url.searchParams.get("source");
    const planQuery = sessionHeadPlanQuery(source, projectId);
    if (planQuery === null) {
      return Response.json({ error: "invalid_plan_source" }, { status: 400 });
    }
    const result = await env.IDX_00.prepare(`EXPLAIN QUERY PLAN ${planQuery.sql}`)
      .bind(...planQuery.bindings)
      .all<{ detail: string }>();
    return Response.json({ plan: (result.results ?? []).map((row) => row.detail) });
  }

  if (request.method === "POST" && url.pathname === "/__test/api/hosted/bootstrap") {
    return testHostedBootstrap(request, env);
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

function sessionHeadPlanQuery(
  source: string | null,
  projectId: string,
): { sql: string; bindings: Array<string | number> } | null {
  if (source === "latestIndexed") {
    return { sql: sessionHeadCandidateSql.latestIndexed, bindings: [projectId, 100] };
  }
  if (source === "outbox" || source === "ledger" || source === "started" || source === "indexed") {
    return { sql: sessionHeadCandidateSql[source], bindings: [projectId, 0, 100] };
  }
  if (source !== "point") return null;
  return buildExactSessionHeadQuery(projectId, { limit: 100, sort: "duration", country: "US" }, [
    "api_old",
    "api_new",
  ]);
}

async function testHostedBootstrap(request: Request, env: Env): Promise<Response> {
  let body: {
    userId?: unknown;
    email?: unknown;
    name?: unknown;
    existingWorkspaceId?: unknown;
    existingProjectForUser?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (
    typeof body.userId !== "string" ||
    typeof body.email !== "string" ||
    typeof body.name !== "string" ||
    (body.existingProjectForUser !== undefined && typeof body.existingProjectForUser !== "boolean")
  ) {
    return Response.json({ error: "invalid_user" }, { status: 400 });
  }

  await createTestDatabaseSchema(env.IDX_00);
  const now = Date.now();
  await env.IDX_00.prepare(
    `INSERT OR IGNORE INTO users
      (id, name, email, email_verified, image, created_at, updated_at, role, banned, ban_reason, ban_expires)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(body.userId, body.name, body.email, 1, null, now, now, "user", 0, null, null)
    .run();

  const existingWorkspaceId =
    typeof body.existingWorkspaceId === "string"
      ? body.existingWorkspaceId
      : `existing_workspace_${await stableUserPartForTest(body.userId)}`;
  if (typeof body.existingWorkspaceId === "string" || body.existingProjectForUser === true) {
    await env.IDX_00.prepare(
      `INSERT OR IGNORE INTO orgs
        (id, name, slug, logo, metadata, shard, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(existingWorkspaceId, "Existing workspace", existingWorkspaceId, null, null, 0, now)
      .run();
  }

  if (body.existingProjectForUser === true) {
    const projectId = `project_${await stableUserPartForTest(body.userId)}`;
    await env.IDX_00.prepare(
      `INSERT INTO projects
        (id, org_id, name, jurisdiction, retention_days, sample_rate,
          allowed_origins, mask_policy_version, mask_rules, capture_toggles,
          quota_state, config_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        projectId,
        existingWorkspaceId,
        "Existing project",
        null,
        30,
        1,
        "[]",
        1,
        "[]",
        JSON.stringify({ heatmaps: false, console: false, network: false, canvas: false }),
        "ok",
        1,
        now - 1,
      )
      .run();
  }

  const auth: SessionAuthContext = {
    ok: true,
    mode: "session",
    projects: new Set(),
    projectRoles: new Map(),
    globalAdmin: false,
    hostedSession: {
      user: {
        id: body.userId,
        name: body.name,
        email: body.email,
        emailVerified: true,
        image: null,
        role: "user",
        banned: false,
        banReason: null,
        banExpires: null,
      },
      session: {
        id: `session_${body.userId}`,
        userId: body.userId,
        expiresAt: new Date(now + 60_000),
        activeOrganizationId: null,
        impersonatedBy: null,
      },
    },
  };

  return bootstrapAccount(env, auth);
}

async function readAnalyticsBootstrapReceipt(url: URL, env: Env): Promise<Response> {
  const projectId = url.searchParams.get("projectId");
  if (projectId === null || !isValidPathId(projectId)) {
    return Response.json({ error: "invalid_project_id" }, { status: 400 });
  }

  await createTestDatabaseSchema(env.IDX_00);
  const row = await env.IDX_00.prepare(
    `SELECT project_id, source_session_count, source_cutoff_ms,
      required_sequence, report_id, completed_at
    FROM analytics_backfill_completions
    WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<AnalyticsBootstrapReceiptRow>();

  return Response.json({
    receipt:
      row === null
        ? null
        : {
            projectId: row.project_id,
            sourceSessionCount: row.source_session_count,
            sourceCutoffMs: row.source_cutoff_ms,
            requiredSequence: row.required_sequence,
            reportId: row.report_id,
            completedAt: row.completed_at,
          },
  });
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

async function seedSessionExport(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    projectId?: unknown;
    sessionId?: unknown;
    exportSequence?: unknown;
    location?: unknown;
  };
  if (
    typeof body.projectId !== "string" ||
    typeof body.sessionId !== "string" ||
    !isValidPathId(body.projectId) ||
    !isValidPathId(body.sessionId) ||
    typeof body.exportSequence !== "number" ||
    !Number.isSafeInteger(body.exportSequence) ||
    body.exportSequence < 1 ||
    (body.location !== "outbox" && body.location !== "ledger")
  ) {
    return Response.json({ error: "invalid_session_export" }, { status: 400 });
  }

  const exportId = `test-session-export-${body.projectId}-${body.sessionId}-${body.exportSequence}`;
  const now = Date.now();
  if (body.location === "outbox") {
    await env.IDX_00.prepare(
      `INSERT OR REPLACE INTO analytics_export_outbox (
        export_sequence, export_id, project_id, session_id, record_kind, payload_json, created_at
      ) VALUES (?, ?, ?, ?, 'session', '{}', ?)`,
    )
      .bind(body.exportSequence, exportId, body.projectId, body.sessionId, now)
      .run();
  } else {
    await env.IDX_00.prepare(
      `INSERT OR REPLACE INTO analytics_export_ledger (
        export_id, export_sequence, project_id, session_id, record_kind, sent_at,
        first_seen_verified_at
      ) VALUES (?, ?, ?, ?, 'session', ?, ?)`,
    )
      .bind(exportId, body.exportSequence, body.projectId, body.sessionId, now, now)
      .run();
  }
  return Response.json({ ok: true });
}

async function markSessionIndexed(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    projectId?: unknown;
    sessionId?: unknown;
    indexedAt?: unknown;
  };
  if (
    typeof body.projectId !== "string" ||
    typeof body.sessionId !== "string" ||
    !isValidPathId(body.projectId) ||
    !isValidPathId(body.sessionId) ||
    typeof body.indexedAt !== "number" ||
    !Number.isSafeInteger(body.indexedAt) ||
    body.indexedAt < 0
  ) {
    return Response.json({ error: "invalid_indexed_session" }, { status: 400 });
  }
  await env.IDX_00.prepare(
    "UPDATE sessions SET indexed_at = ? WHERE project_id = ? AND session_id = ?",
  )
    .bind(body.indexedAt, body.projectId, body.sessionId)
    .run();
  return Response.json({ ok: true });
}

async function seedSessionHeadNoise(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    projectId?: unknown;
    count?: unknown;
    indexedAt?: unknown;
  };
  if (
    typeof body.projectId !== "string" ||
    !isValidPathId(body.projectId) ||
    typeof body.count !== "number" ||
    !Number.isSafeInteger(body.count) ||
    body.count < 1 ||
    body.count > 200 ||
    typeof body.indexedAt !== "number" ||
    !Number.isSafeInteger(body.indexedAt) ||
    body.indexedAt < 0
  ) {
    return Response.json({ error: "invalid_session_head_noise" }, { status: 400 });
  }

  const selectedColumns = sessionRowColumns.map((column) =>
    column === "session_id"
      ? `'head_noise_' || printf('%03d', sequence.value)`
      : `template.${column}`,
  );
  await env.IDX_00.prepare(
    `WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < ?
    )
    INSERT OR REPLACE INTO sessions (${sessionRowColumns.join(", ")}, indexed_at)
    SELECT ${selectedColumns.join(", ")}, ? + sequence.value
    FROM sequence
    CROSS JOIN sessions AS template
    WHERE template.project_id = ? AND template.session_id = 'api_mid'`,
  )
    .bind(body.count, body.indexedAt, body.projectId)
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

async function stableUserPartForTest(userId: string): Promise<string> {
  const bytes = new TextEncoder().encode(userId);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let value = "";
  for (const byte of digest.slice(0, 10)) {
    value += byte.toString(16).padStart(2, "0");
  }
  return value;
}
