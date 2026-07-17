import { finalizeMessageSchema } from "@orange-replay/shared";
import { isValidPathId, parseRecordingObjectKey } from "../api/helpers.ts";
import { finalizeTraceKey, indexSession } from "../consumer/queue.ts";
import { sweepExpiredSessions } from "../consumer/sweeper.ts";
import type { Env } from "../env.ts";
import { reserveAcceptedUsage } from "../usage/accepted-usage.ts";
import { createTestDatabaseSchema } from "./database-schema.ts";

const SESSION_COLUMNS = [
  "session_id",
  "project_id",
  "org_id",
  "started_at",
  "ended_at",
  "duration_ms",
  "country",
  "region",
  "city",
  "device",
  "browser",
  "os",
  "entry_url",
  "url_count",
  "page_count",
  "analytics_version",
  "max_scroll_depth",
  "quick_backs",
  "interaction_time_ms",
  "activity_hist",
  "clicks",
  "errors",
  "rages",
  "navs",
  "bytes",
  "segment_count",
  "flags",
  "manifest_key",
  "expires_at",
] as const;

type JsonRecord = Record<string, unknown>;

export async function handleConsumerTestRoutes(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "POST" && path === "/__test/consumer/seed-schema") {
    return seedSchema(env);
  }

  if (request.method === "POST" && path === "/__test/consumer/send") {
    return sendFinalizeMessage(request, env);
  }

  if (request.method === "GET" && path === "/__test/consumer/session") {
    return readSession(url, env);
  }

  if (request.method === "GET" && path === "/__test/consumer/finalize-trace") {
    return readFinalizeTrace(url, env);
  }

  if (request.method === "GET" && path === "/__test/consumer/usage") {
    return readUsage(url, env);
  }

  if (request.method === "GET" && path === "/__test/consumer/usage-ledger") {
    return readUsageLedger(url, env);
  }

  if (request.method === "POST" && path === "/__test/consumer/index-now") {
    return indexFinalizeMessageNow(request, env);
  }

  if (request.method === "POST" && path === "/__test/consumer/reserve-usage") {
    return reserveUsageNow(request, env);
  }

  if (request.method === "POST" && path === "/__test/consumer/fail-usage-reservation") {
    return configureUsageReservationFailure(request, env);
  }

  if (request.method === "POST" && path === "/__test/consumer/seed-session") {
    return seedSession(request, env);
  }

  if (request.method === "POST" && path === "/__test/consumer/seed-project") {
    return seedProject(request, env);
  }

  if (request.method === "POST" && path === "/__test/consumer/seed-deletion") {
    return seedDeletionMarker(request, env);
  }

  if (request.method === "POST" && path === "/__test/consumer/fail-event-insert") {
    return failEventInsert(url, env);
  }

  if (request.method === "POST" && path === "/__test/consumer/fail-session-delete") {
    return failSessionDelete(url, env);
  }

  if (request.method === "POST" && path === "/__test/consumer/sweep") {
    await sweepExpiredSessions(env);
    return Response.json({ ok: true });
  }

  if (request.method === "GET" && path === "/__test/consumer/r2") {
    return readR2Object(url, env);
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

async function readFinalizeTrace(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("id");
  if (sessionId === null || sessionId.length === 0) {
    return Response.json({ error: "missing session id" }, { status: 400 });
  }

  const trace = await env.CONFIG.get(finalizeTraceKey(sessionId), { type: "json" });
  return Response.json({ trace });
}

async function seedSchema(env: Env): Promise<Response> {
  await createTestDatabaseSchema(env.IDX_00);
  return Response.json({ ok: true });
}

async function sendFinalizeMessage(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  if (!("message" in body)) {
    return Response.json({ error: "missing message" }, { status: 400 });
  }

  await (env.FINALIZE_QUEUE as Queue<unknown>).send(body["message"], { contentType: "json" });
  return Response.json({ ok: true });
}

async function readSession(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("id");
  if (sessionId === null || sessionId.length === 0) {
    return Response.json({ error: "missing session id" }, { status: 400 });
  }
  const projectId = url.searchParams.get("project");

  const session =
    projectId === null || projectId.length === 0
      ? await env.IDX_00.prepare(
          "SELECT * FROM sessions WHERE session_id = ? ORDER BY project_id LIMIT 1",
        )
          .bind(sessionId)
          .first<JsonRecord>()
      : await env.IDX_00.prepare("SELECT * FROM sessions WHERE project_id = ? AND session_id = ?")
          .bind(projectId, sessionId)
          .first<JsonRecord>();
  const eventProjectId = typeof session?.["project_id"] === "string" ? session["project_id"] : "";
  const events = await env.IDX_00.prepare(
    "SELECT project_id, session_id, t, kind, detail FROM session_events WHERE project_id = ? AND session_id = ? ORDER BY t, kind",
  )
    .bind(eventProjectId, sessionId)
    .all<JsonRecord>();
  const orgId = typeof session?.["org_id"] === "string" ? session["org_id"] : "";
  const usage =
    orgId.length > 0
      ? await env.IDX_00.prepare(
          "SELECT org_id, month, sessions, bytes FROM usage_monthly WHERE org_id = ? ORDER BY month",
        )
          .bind(orgId)
          .all<JsonRecord>()
      : { results: [] };
  const outbox = await env.IDX_00.prepare(
    `SELECT export_sequence, export_id, project_id, session_id, record_kind, payload_json,
      created_at, sent_at, attempt_count, last_error
    FROM analytics_export_outbox
    WHERE project_id = ? AND session_id = ?
    ORDER BY export_sequence`,
  )
    .bind(eventProjectId, sessionId)
    .all<JsonRecord>();

  return Response.json({
    session: session ?? null,
    events: events.results,
    usage: usage.results,
    outbox: outbox.results,
  });
}

async function readUsage(url: URL, env: Env): Promise<Response> {
  const orgId = url.searchParams.get("org");
  if (orgId === null || orgId.length === 0) {
    return Response.json({ error: "missing org id" }, { status: 400 });
  }

  const usage = await env.IDX_00.prepare(
    "SELECT org_id, month, sessions, bytes FROM usage_monthly WHERE org_id = ? ORDER BY month",
  )
    .bind(orgId)
    .all<JsonRecord>();

  return Response.json({ usage: usage.results });
}

async function readUsageLedger(url: URL, env: Env): Promise<Response> {
  const projectId = url.searchParams.get("project");
  const sessionId = url.searchParams.get("session");
  if (projectId === null || sessionId === null) {
    return Response.json({ error: "missing session identity" }, { status: 400 });
  }

  const ledger = await env.IDX_00.prepare(
    `SELECT project_id, session_id, org_id, month, bytes, updated_at
    FROM accepted_usage_sessions
    WHERE project_id = ? AND session_id = ?`,
  )
    .bind(projectId, sessionId)
    .first<JsonRecord>();
  return Response.json({ ledger: ledger ?? null });
}

async function reserveUsageNow(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const projectId = body["projectId"];
  const sessionId = body["sessionId"];
  const orgId = body["orgId"];
  const month = body["month"];
  const bytes = body["bytes"];
  if (
    typeof projectId !== "string" ||
    typeof sessionId !== "string" ||
    typeof orgId !== "string" ||
    typeof month !== "string" ||
    typeof bytes !== "number"
  ) {
    return Response.json({ error: "invalid usage reservation" }, { status: 400 });
  }

  try {
    await reserveAcceptedUsage(env.IDX_00, {
      projectId,
      sessionId,
      orgId,
      month,
      bytes,
      updatedAt: Date.now(),
      source: "append",
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "usage_reservation_failed" }, { status: 409 });
  }
}

async function configureUsageReservationFailure(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const projectId = body["projectId"];
  const sessionId = body["sessionId"];
  const enabled = body["enabled"];
  if (
    typeof projectId !== "string" ||
    typeof sessionId !== "string" ||
    typeof enabled !== "boolean" ||
    !isValidPathId(projectId) ||
    !isValidPathId(sessionId)
  ) {
    return Response.json({ error: "invalid usage failure" }, { status: 400 });
  }

  await env.IDX_00.prepare("DROP TRIGGER IF EXISTS __test_fail_usage_reservation").run();
  if (enabled) {
    await env.IDX_00.prepare(
      `CREATE TRIGGER __test_fail_usage_reservation
      BEFORE INSERT ON accepted_usage_sessions
      WHEN NEW.project_id = ${quoteSqlString(projectId)}
        AND NEW.session_id = ${quoteSqlString(sessionId)}
      BEGIN
        SELECT RAISE(ABORT, 'forced accepted usage reservation failure');
      END`,
    ).run();
  }
  return Response.json({ ok: true });
}

async function indexFinalizeMessageNow(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  const parsed = finalizeMessageSchema.safeParse(body["message"]);
  if (!parsed.success) {
    return Response.json({ error: "invalid finalize message" }, { status: 400 });
  }

  try {
    const exportForTest = new URL(request.url).searchParams.get("warehouse") === "1";
    const testEnv: Env = exportForTest
      ? {
          ...env,
          ANALYTICS_EXPORT_ENABLED: "1",
          ANALYTICS_STREAM: { async send() {} },
        }
      : env;
    return Response.json(await indexSession(testEnv, parsed.data));
  } catch {
    return Response.json({ error: "index_failed" }, { status: 500 });
  }
}

async function seedProject(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const projectId = body["projectId"];
  const jurisdiction = body["jurisdiction"];
  if (
    typeof projectId !== "string" ||
    !isValidPathId(projectId) ||
    (jurisdiction !== null && (typeof jurisdiction !== "string" || jurisdiction.length > 64))
  ) {
    return Response.json({ error: "invalid project" }, { status: 400 });
  }
  const orgId = `org-${projectId}`;
  const now = Date.now();
  await env.IDX_00.batch([
    env.IDX_00.prepare(
      `INSERT OR IGNORE INTO orgs (id, name, slug, shard, created_at)
      VALUES (?, ?, ?, 0, ?)`,
    ).bind(orgId, orgId, `slug-${projectId}`, now),
    env.IDX_00.prepare(
      `INSERT OR REPLACE INTO projects (
        id, org_id, name, jurisdiction, retention_days, sample_rate,
        allowed_origins, mask_policy_version, mask_rules, capture_toggles,
        quota_state, config_version, created_at
      ) VALUES (?, ?, ?, ?, 30, 1, '["*"]', 1, '[]', '{}', 'ok', 1, ?)`,
    ).bind(projectId, orgId, projectId, jurisdiction, now),
  ]);
  return Response.json({ ok: true });
}

async function seedSession(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  const session = body["session"];
  const r2Keys = body["r2Keys"];
  if (!isRecord(session)) {
    return Response.json({ error: "missing session" }, { status: 400 });
  }
  if (!Array.isArray(r2Keys) || !r2Keys.every((key) => typeof key === "string")) {
    return Response.json({ error: "missing r2 keys" }, { status: 400 });
  }
  const parsedKeys = r2Keys.map((key) => parseRecordingObjectKey(key));
  if (!parsedKeys.every((key) => key.ok)) {
    return Response.json({ error: "bad r2 key" }, { status: 400 });
  }

  const missingColumn = SESSION_COLUMNS.find(
    (column) => session[column] === undefined && !canBeNull(column),
  );
  if (missingColumn !== undefined) {
    return Response.json({ error: `missing ${missingColumn}` }, { status: 400 });
  }

  await insertSessionRow(env.IDX_00, session);
  await seedSessionEvents(env.IDX_00, session["project_id"], session["session_id"], body["events"]);

  for (const key of parsedKeys) {
    if (key.ok) {
      await env.RECORDINGS.put(key.key, "ok");
    }
  }

  return Response.json({ ok: true });
}

async function seedDeletionMarker(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  const projectId = body["projectId"];
  const sessionId = body["sessionId"];
  if (
    typeof projectId !== "string" ||
    typeof sessionId !== "string" ||
    !isValidPathId(projectId) ||
    !isValidPathId(sessionId)
  ) {
    return Response.json({ error: "projectId and sessionId are required" }, { status: 400 });
  }

  await env.IDX_00.prepare(
    `INSERT INTO session_deletions (project_id, session_id, requested_at, attempts)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(project_id, session_id) DO UPDATE SET attempts = attempts + 1`,
  )
    .bind(projectId, sessionId, Date.now())
    .run();

  return Response.json({ ok: true });
}

async function failEventInsert(url: URL, env: Env): Promise<Response> {
  const sessionId = readSafeSessionId(url);
  if (sessionId === null) {
    return Response.json({ error: "missing session id" }, { status: 400 });
  }

  await env.IDX_00.prepare("DROP TRIGGER IF EXISTS test_fail_event_insert").run();
  await env.IDX_00.prepare(
    `CREATE TRIGGER test_fail_event_insert BEFORE INSERT ON session_events WHEN NEW.session_id = ${quoteSqlString(sessionId)} BEGIN SELECT RAISE(ABORT, 'forced event insert failure'); END`,
  ).run();

  return Response.json({ ok: true });
}

async function failSessionDelete(url: URL, env: Env): Promise<Response> {
  const sessionId = readSafeSessionId(url);
  if (sessionId === null) {
    return Response.json({ error: "missing session id" }, { status: 400 });
  }

  await env.IDX_00.prepare("DROP TRIGGER IF EXISTS test_fail_session_delete").run();
  await env.IDX_00.prepare(
    `CREATE TRIGGER test_fail_session_delete BEFORE DELETE ON sessions WHEN OLD.session_id = ${quoteSqlString(sessionId)} BEGIN SELECT RAISE(ABORT, 'forced session delete failure'); END`,
  ).run();

  return Response.json({ ok: true });
}

async function readR2Object(url: URL, env: Env): Promise<Response> {
  const key = url.searchParams.get("key");
  const parsed = key === null ? { ok: false as const } : parseRecordingObjectKey(key);
  if (!parsed.ok) {
    return Response.json({ error: "bad r2 key" }, { status: 400 });
  }

  const object = await env.RECORDINGS.head(parsed.key);
  return Response.json({ exists: object !== null });
}

async function readJsonBody(request: Request): Promise<JsonRecord | Response> {
  try {
    const body = (await request.json()) as unknown;
    if (!isRecord(body)) {
      return Response.json({ error: "body must be an object" }, { status: 400 });
    }
    return body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSafeSessionId(url: URL): string | null {
  const sessionId = url.searchParams.get("id");
  if (sessionId === null || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    return null;
  }
  return sessionId;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function canBeNull(column: (typeof SESSION_COLUMNS)[number]): boolean {
  return (
    column === "country" ||
    column === "region" ||
    column === "city" ||
    column === "device" ||
    column === "browser" ||
    column === "os" ||
    column === "entry_url" ||
    column === "page_count" ||
    column === "max_scroll_depth" ||
    column === "quick_backs" ||
    column === "interaction_time_ms" ||
    column === "activity_hist"
  );
}

async function insertSessionRow(db: D1Database, session: JsonRecord): Promise<void> {
  const placeholders = SESSION_COLUMNS.map(() => "?").join(", ");
  await db
    .prepare(
      `INSERT OR REPLACE INTO sessions (${SESSION_COLUMNS.join(", ")}) VALUES (${placeholders})`,
    )
    .bind(...SESSION_COLUMNS.map((column) => session[column] ?? null))
    .run();
}

async function seedSessionEvents(
  db: D1Database,
  projectId: unknown,
  sessionId: unknown,
  events: unknown,
): Promise<void> {
  if (typeof projectId !== "string" || typeof sessionId !== "string" || !Array.isArray(events))
    return;

  const statements = events
    .filter(isRecord)
    .map((event) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO session_events (project_id, session_id, t, kind, detail) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          projectId,
          sessionId,
          event["t"] ?? 0,
          event["kind"] ?? "custom",
          event["detail"] ?? null,
        ),
    );
  if (statements.length > 0) {
    await db.batch(statements);
  }
}
