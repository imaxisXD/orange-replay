import { finalizeMessageSchema } from "@orange-replay/shared";
import { indexSession } from "../consumer/queue.ts";
import { sweepExpiredSessions } from "../consumer/sweeper.ts";
import type { Env } from "../env.ts";

const SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, shard INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
  'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, jurisdiction TEXT, retention_days INTEGER NOT NULL DEFAULT 30, sample_rate REAL NOT NULL DEFAULT 1.0, allowed_origins TEXT NOT NULL DEFAULT \'["*"]\', mask_policy_version INTEGER NOT NULL DEFAULT 1, mask_rules TEXT NOT NULL DEFAULT \'[]\', capture_toggles TEXT NOT NULL DEFAULT \'{"heatmaps":false,"console":false,"network":false,"canvas":false}\', quota_state TEXT NOT NULL DEFAULT \'ok\', config_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)',
  "CREATE TABLE IF NOT EXISTS keys (key_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, org_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, country TEXT, region TEXT, city TEXT, device TEXT, browser TEXT, os TEXT, entry_url TEXT, url_count INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, rages INTEGER NOT NULL DEFAULT 0, navs INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, segment_count INTEGER NOT NULL DEFAULT 0, flags INTEGER NOT NULL DEFAULT 0, manifest_key TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_time ON sessions(project_id, started_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)",
  "CREATE TABLE IF NOT EXISTS session_events (session_id TEXT NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT, PRIMARY KEY (session_id, t, kind))",
  "CREATE TABLE IF NOT EXISTS usage_monthly (org_id TEXT NOT NULL, month TEXT NOT NULL, sessions INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (org_id, month))",
];

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

  if (request.method === "GET" && path === "/__test/consumer/usage") {
    return readUsage(url, env);
  }

  if (request.method === "POST" && path === "/__test/consumer/index-now") {
    return indexFinalizeMessageNow(request, env);
  }

  if (request.method === "POST" && path === "/__test/consumer/seed-session") {
    return seedSession(request, env);
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

async function seedSchema(env: Env): Promise<Response> {
  for (const statement of SCHEMA_STATEMENTS) {
    await env.IDX_00.prepare(statement).run();
  }
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

  const session = await env.IDX_00.prepare("SELECT * FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<JsonRecord>();
  const events = await env.IDX_00.prepare(
    "SELECT session_id, t, kind, detail FROM session_events WHERE session_id = ? ORDER BY t, kind",
  )
    .bind(sessionId)
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

  return Response.json({
    session: session ?? null,
    events: events.results,
    usage: usage.results,
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

async function indexFinalizeMessageNow(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  const parsed = finalizeMessageSchema.safeParse(body["message"]);
  if (!parsed.success) {
    return Response.json({ error: "invalid finalize message" }, { status: 400 });
  }

  try {
    return Response.json(await indexSession(env, parsed.data));
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
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
  if (!r2Keys.every((key) => key.startsWith("p/"))) {
    return Response.json({ error: "bad r2 key" }, { status: 400 });
  }

  const missingColumn = SESSION_COLUMNS.find(
    (column) => session[column] === undefined && !canBeNull(column),
  );
  if (missingColumn !== undefined) {
    return Response.json({ error: `missing ${missingColumn}` }, { status: 400 });
  }

  await insertSessionRow(env.IDX_00, session);
  await seedSessionEvents(env.IDX_00, session["session_id"], body["events"]);

  for (const key of r2Keys) {
    await env.RECORDINGS.put(key, "ok");
  }

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
  if (key === null || !key.startsWith("p/")) {
    return Response.json({ error: "bad r2 key" }, { status: 400 });
  }

  const object = await env.RECORDINGS.head(key);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canBeNull(column: (typeof SESSION_COLUMNS)[number]): boolean {
  return (
    column === "country" ||
    column === "region" ||
    column === "city" ||
    column === "device" ||
    column === "browser" ||
    column === "os" ||
    column === "entry_url"
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
  sessionId: unknown,
  events: unknown,
): Promise<void> {
  if (typeof sessionId !== "string" || !Array.isArray(events)) return;

  const statements = events
    .filter(isRecord)
    .map((event) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO session_events (session_id, t, kind, detail) VALUES (?, ?, ?, ?)",
        )
        .bind(sessionId, event["t"] ?? 0, event["kind"] ?? "custom", event["detail"] ?? null),
    );
  if (statements.length > 0) {
    await db.batch(statements);
  }
}
