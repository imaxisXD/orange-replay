import {
  HDR_REQUEST_ID,
  MAX_LIVE_SESSIONS_PER_PROJECT,
  MAX_PRESENCE_BODY_BYTES,
  MAX_PRESENCE_ID_CHARS,
  MAX_PRESENCE_TEXT_CHARS,
  startWideEvent,
  uuidv7,
} from "@orange-replay/shared";
import type { WideEventOutcome } from "@orange-replay/shared";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { devTestRoutesFlag, isDevTestMode, setWorkerLoggerVersion } from "../env.ts";
import { resolvePresenceTiming, sessionActivity } from "./presence-logic.ts";
import type {
  PresenceHeadCursor,
  PresenceHeadQuery,
  PresenceHeadSort,
  PresenceSession,
  PresenceSessionHead,
} from "./presence-logic.ts";

type SqlRowValue = string | number | null;

const JSON_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_HEAD_LIMIT = 100;
const MAX_HEAD_LIMIT = 100;
const MAX_TRACKED_HEADS = 100;
const MAX_HEAD_RESPONSE_ROWS = 200;
const MAX_SQL_BINDINGS = 100;
const RETENTION_DAY_MS = 86_400_000;
const MAX_RETENTION_MS = 365 * RETENTION_DAY_MS;
const presenceColumns = [
  "session_id",
  "org_id",
  "started_at",
  "last_seen",
  "finalizing_at",
  "entry_url",
  "country",
  "region",
  "city",
  "browser",
  "os",
  "device",
  "flags",
].join(", ");

interface PresenceRow extends PresenceSession {
  org_id: string | null;
  finalizing_at: number | null;
  region: string | null;
  flags: number;
  [key: string]: SqlRowValue;
}

interface MetaRow {
  [key: string]: SqlRowValue;
  v: string | null;
}

interface CountRow {
  [key: string]: SqlRowValue;
  count: number;
}

interface ValidPresencePing {
  projectId: string;
  sessionId: string;
  orgId: string | null;
  startedAt: number;
  lastSeen: number;
  entryUrl: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  flags: number;
  expiresAt: number;
}

interface ValidPresenceHeadQuery extends PresenceHeadQuery {
  projectId: string;
}

export class PresenceRegistry extends DurableObject<Env> {
  private firstEventSeeded = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setWorkerLoggerVersion(env);
    this.createSchema();
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get(HDR_REQUEST_ID) ?? uuidv7();
    const event = startWideEvent("worker", "do.presence", requestId);
    let statusCode = 500;
    let outcome: WideEventOutcome = "server_error";

    try {
      const response = await this.routeRequest(request, url, event);
      statusCode = response.status;
      outcome = statusCode >= 500 ? "server_error" : statusCode >= 400 ? "client_error" : "success";
      return response;
    } catch (error) {
      event.fail(error);
      const response = jsonResponse({ error: "presence registry failed" }, { status: 500 });
      statusCode = response.status;
      return response;
    } finally {
      event.set({ route: safePresenceRoute(url.pathname), status_code: statusCode });
      event.emit(outcome);
    }
  }

  private async routeRequest(
    request: Request,
    url: URL,
    event: ReturnType<typeof startWideEvent>,
  ): Promise<Response> {
    if (request.method === "POST" && url.pathname === "/ping") {
      const json = await readJson(request);
      if (!json.ok) return jsonResponse({ error: json.error }, { status: json.status });
      const body = readPingBody(json.value);
      if (!body.ok) return jsonResponse({ error: body.error }, { status: 400 });
      event.set({
        project_id: body.value.projectId,
        session_id: body.value.sessionId,
        route: "ping",
      });
      this.ping(body.value);
      return jsonResponse({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/remove") {
      const json = await readJson(request);
      if (!json.ok) return jsonResponse({ error: json.error }, { status: json.status });
      const body = readRemoveBody(json.value);
      if (!body.ok) return jsonResponse({ error: body.error }, { status: 400 });
      event.set({
        project_id: body.value.projectId,
        session_id: body.value.sessionId,
        route: "remove",
      });
      this.remove(body.value.sessionId);
      return jsonResponse({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/mark-finalizing") {
      const json = await readJson(request);
      if (!json.ok) return jsonResponse({ error: json.error }, { status: json.status });
      const body = readFinalizingBody(json.value);
      if (!body.ok) return jsonResponse({ error: body.error }, { status: 400 });
      event.set({
        project_id: body.value.projectId,
        session_id: body.value.sessionId,
        route: "mark_finalizing",
      });
      this.markFinalizing(body.value.sessionId, body.value.finalizingAt);
      return jsonResponse({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/list") {
      const json = await readJson(request);
      if (!json.ok) return jsonResponse({ error: json.error }, { status: json.status });
      const body = readListBody(json.value);
      if (!body.ok) return jsonResponse({ error: body.error }, { status: 400 });
      event.set({ project_id: body.value.projectId, route: "list" });
      return jsonResponse({
        sessions: this.listLive(body.value.now),
      });
    }

    if (request.method === "POST" && url.pathname === "/heads") {
      const json = await readJson(request);
      if (!json.ok) return jsonResponse({ error: json.error }, { status: json.status });
      const body = readHeadsBody(json.value);
      if (!body.ok) return jsonResponse({ error: body.error }, { status: 400 });
      event.set({ project_id: body.value.projectId, route: "heads" });
      return jsonResponse({
        sessions: this.listHeads(body.value),
      });
    }

    if (request.method === "POST" && url.pathname === "/head") {
      const json = await readJson(request);
      if (!json.ok) return jsonResponse({ error: json.error }, { status: json.status });
      const body = readHeadBody(json.value);
      if (!body.ok) return jsonResponse({ error: body.error }, { status: 400 });
      event.set({
        project_id: body.value.projectId,
        session_id: body.value.sessionId,
        route: "head",
      });
      return jsonResponse({ session: this.readHead(body.value.sessionId, body.value.now) });
    }

    if (request.method === "POST" && url.pathname === "/install-status") {
      const json = await readJson(request);
      if (!json.ok) return jsonResponse({ error: json.error }, { status: json.status });
      const body = readListBody(json.value);
      if (!body.ok) return jsonResponse({ error: body.error }, { status: 400 });
      event.set({ project_id: body.value.projectId, route: "install_status" });
      return jsonResponse({ firstEventAt: this.firstEventAt() });
    }

    if (request.method === "POST" && url.pathname === "/debug" && isDevTestMode(this.env)) {
      const json = await readJson(request);
      if (!json.ok) return jsonResponse({ error: json.error }, { status: json.status });
      const body = readListBody(json.value);
      if (!body.ok) return jsonResponse({ error: body.error }, { status: 400 });
      event.set({ project_id: body.value.projectId, route: "debug" });
      return jsonResponse({
        rows: this.countRows(),
        firstEventAt: this.firstEventAt(),
      });
    }

    return jsonResponse({ error: "not_found" }, { status: 404 });
  }

  private createSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS presence (
        session_id TEXT PRIMARY KEY,
        org_id TEXT,
        started_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        finalizing_at INTEGER,
        entry_url TEXT,
        country TEXT,
        region TEXT,
        city TEXT,
        browser TEXT,
        os TEXT,
        device TEXT,
        flags INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS project_meta (
        k TEXT PRIMARY KEY,
        v TEXT
      );
    `);

    const columns = new Set(
      this.ctx.storage.sql
        .exec<{ name: string; [key: string]: SqlRowValue }>("PRAGMA table_info(presence)")
        .toArray()
        .map((row) => row.name),
    );
    if (!columns.has("org_id")) {
      this.ctx.storage.sql.exec("ALTER TABLE presence ADD COLUMN org_id TEXT");
    }
    if (!columns.has("finalizing_at")) {
      this.ctx.storage.sql.exec("ALTER TABLE presence ADD COLUMN finalizing_at INTEGER");
    }
    if (!columns.has("region")) {
      this.ctx.storage.sql.exec("ALTER TABLE presence ADD COLUMN region TEXT");
    }
    if (!columns.has("flags")) {
      this.ctx.storage.sql.exec("ALTER TABLE presence ADD COLUMN flags INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.has("expires_at")) {
      this.ctx.storage.sql.exec("ALTER TABLE presence ADD COLUMN expires_at INTEGER");
    }
    this.ctx.storage.sql.exec(
      "UPDATE presence SET expires_at = last_seen + ? WHERE expires_at IS NULL",
      MAX_RETENTION_MS,
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON presence(last_seen DESC, session_id)",
    );
  }

  private ping(input: {
    sessionId: string;
    orgId: string | null;
    startedAt: number;
    lastSeen: number;
    entryUrl: string | null;
    country: string | null;
    region: string | null;
    city: string | null;
    browser: string | null;
    os: string | null;
    device: string | null;
    flags: number;
    expiresAt: number;
  }): void {
    if (!this.firstEventSeeded) {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO project_meta (k, v)
          VALUES ('first_event_at', ?)`,
        String(input.lastSeen),
      );
      // Hibernation resets this in-memory flag, so one later no-op insert is expected.
      this.firstEventSeeded = true;
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO presence
        (session_id, org_id, started_at, last_seen, finalizing_at, entry_url, country, region, city, browser, os, device, flags, expires_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          last_seen = MAX(presence.last_seen, excluded.last_seen),
          org_id = CASE WHEN excluded.last_seen >= presence.last_seen THEN COALESCE(excluded.org_id, presence.org_id) ELSE presence.org_id END,
          entry_url = CASE WHEN excluded.last_seen >= presence.last_seen THEN COALESCE(excluded.entry_url, presence.entry_url) ELSE presence.entry_url END,
          country = CASE WHEN excluded.last_seen >= presence.last_seen THEN COALESCE(excluded.country, presence.country) ELSE presence.country END,
          region = CASE WHEN excluded.last_seen >= presence.last_seen THEN COALESCE(excluded.region, presence.region) ELSE presence.region END,
          city = CASE WHEN excluded.last_seen >= presence.last_seen THEN COALESCE(excluded.city, presence.city) ELSE presence.city END,
          browser = CASE WHEN excluded.last_seen >= presence.last_seen THEN COALESCE(excluded.browser, presence.browser) ELSE presence.browser END,
          os = CASE WHEN excluded.last_seen >= presence.last_seen THEN COALESCE(excluded.os, presence.os) ELSE presence.os END,
          device = CASE WHEN excluded.last_seen >= presence.last_seen THEN COALESCE(excluded.device, presence.device) ELSE presence.device END,
          flags = CASE WHEN excluded.last_seen >= presence.last_seen THEN excluded.flags ELSE presence.flags END,
          expires_at = MAX(COALESCE(presence.expires_at, 0), excluded.expires_at)`,
      input.sessionId,
      input.orgId,
      input.startedAt,
      input.lastSeen,
      input.entryUrl,
      input.country,
      input.region,
      input.city,
      input.browser,
      input.os,
      input.device,
      input.flags,
      input.expiresAt,
    );
  }

  private markFinalizing(sessionId: string, finalizingAt: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE presence
        SET finalizing_at = CASE
            WHEN finalizing_at IS NULL THEN ?
            ELSE MAX(finalizing_at, ?)
          END,
          expires_at = COALESCE(expires_at, ?)
        WHERE session_id = ?`,
      finalizingAt,
      finalizingAt,
      finalizingAt + MAX_RETENTION_MS,
      sessionId,
    );
  }

  private remove(sessionId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM presence WHERE session_id = ?", sessionId);
  }

  private listLive(now: number): PresenceSession[] {
    const timing = resolvePresenceTiming(devTestRoutesFlag(this.env), this.env.TEST_TIMINGS);
    this.pruneExpired(now, timing.closeMs + timing.headGraceMs);
    const liveCutoff = now - timing.ttlMs;

    return this.ctx.storage.sql
      .exec<PresenceRow>(
        `SELECT ${presenceColumns}
          FROM presence
          WHERE finalizing_at IS NULL AND last_seen >= ?
          ORDER BY last_seen DESC, session_id ASC
          LIMIT ?`,
        liveCutoff,
        MAX_LIVE_SESSIONS_PER_PROJECT + 1,
      )
      .toArray();
  }

  private listHeads(query: ValidPresenceHeadQuery): PresenceSessionHead[] {
    const timing = resolvePresenceTiming(devTestRoutesFlag(this.env), this.env.TEST_TIMINGS);
    this.pruneExpired(query.now, timing.closeMs + timing.headGraceMs);
    const built = buildPresenceHeadsSql(query);
    const rows = this.ctx.storage.sql.exec<PresenceRow>(built.sql, ...built.bindings).toArray();
    const bySession = new Map(rows.map((row) => [row.session_id, row]));
    for (const tracked of buildTrackedPresenceHeadsSql(query)) {
      for (const row of this.ctx.storage.sql
        .exec<PresenceRow>(tracked.sql, ...tracked.bindings)
        .toArray()) {
        bySession.set(row.session_id, row);
      }
    }
    const responseLimit = Math.min(
      MAX_HEAD_RESPONSE_ROWS,
      query.limit + (query.trackedSessionIds?.length ?? 0),
    );
    return [...bySession.values()]
      .toSorted(presenceRowComparator(query))
      .slice(0, responseLimit)
      .map((row) => ({ ...row, activity: sessionActivity(row, query.now, timing.ttlMs) }));
  }

  private readHead(sessionId: string, now: number): PresenceSessionHead | null {
    const timing = resolvePresenceTiming(devTestRoutesFlag(this.env), this.env.TEST_TIMINGS);
    this.pruneExpired(now, timing.closeMs + timing.headGraceMs);
    const row = this.ctx.storage.sql
      .exec<PresenceRow>(`SELECT ${presenceColumns} FROM presence WHERE session_id = ?`, sessionId)
      .toArray()[0];
    return row === undefined ? null : { ...row, activity: sessionActivity(row, now, timing.ttlMs) };
  }

  private pruneExpired(now: number, keepMs: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM presence
      WHERE (finalizing_at IS NULL AND last_seen < ?)
        OR (finalizing_at IS NOT NULL AND expires_at <= ?)`,
      now - keepMs,
      now,
    );
  }

  private firstEventAt(): number | null {
    const row = this.ctx.storage.sql
      .exec<MetaRow>("SELECT v FROM project_meta WHERE k = 'first_event_at'")
      .toArray()[0];
    if (row?.v === undefined || row.v === null) {
      return null;
    }

    const value = Number(row.v);
    return Number.isFinite(value) ? value : null;
  }

  private countRows(): number {
    return this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM presence").one()
      .count;
  }
}

function buildPresenceHeadsSql(query: PresenceHeadQuery): {
  sql: string;
  bindings: Array<string | number>;
} {
  const built = buildPresenceHeadsWhere(query);
  const whereSql = built.where.length === 0 ? "" : `WHERE ${built.where.join(" AND ")}`;
  return {
    sql: `SELECT ${presenceColumns}
      FROM presence
      ${whereSql}
      ORDER BY ${built.sortSql} DESC, session_id DESC
      LIMIT ?`,
    bindings: [...built.bindings, query.limit],
  };
}

function buildTrackedPresenceHeadsSql(query: PresenceHeadQuery): {
  sql: string;
  bindings: Array<string | number>;
}[] {
  const trackedSessionIds = query.trackedSessionIds ?? [];
  if (trackedSessionIds.length === 0) return [];
  const built = buildPresenceHeadsWhere(query);
  const idsPerQuery = Math.max(1, MAX_SQL_BINDINGS - built.bindings.length);
  const queries: Array<{ sql: string; bindings: Array<string | number> }> = [];

  for (let start = 0; start < trackedSessionIds.length; start += idsPerQuery) {
    const sessionIds = trackedSessionIds.slice(start, start + idsPerQuery);
    const where = [...built.where, `session_id IN (${sessionIds.map(() => "?").join(", ")})`];
    queries.push({
      sql: `SELECT ${presenceColumns}
        FROM presence
        WHERE ${where.join(" AND ")}`,
      bindings: [...built.bindings, ...sessionIds],
    });
  }

  return queries;
}

function buildPresenceHeadsWhere(query: PresenceHeadQuery): {
  where: string[];
  bindings: Array<string | number>;
  sortSql: string;
} {
  const where: string[] = [];
  const bindings: Array<string | number> = [];
  const durationSql = "MAX(0, last_seen - started_at)";
  const sortSql = query.sort === "duration" ? durationSql : "started_at";

  if (query.from !== undefined) {
    where.push("started_at >= ?");
    bindings.push(query.from);
  }
  if (query.to !== undefined) {
    where.push("started_at <= ?");
    bindings.push(query.to);
  }
  addExactPresenceFilter(where, bindings, "country", query.country);
  addExactPresenceFilter(where, bindings, "region", query.region);
  addExactPresenceFilter(where, bindings, "device", query.device);
  addExactPresenceFilter(where, bindings, "browser", query.browser);
  addExactPresenceFilter(where, bindings, "os", query.os);
  addExactPresenceFilter(where, bindings, "entry_url", query.entryUrl);
  if (query.entryUrlPrefix !== undefined) {
    where.push("entry_url IS NOT NULL AND substr(entry_url, 1, length(?)) = ?");
    bindings.push(query.entryUrlPrefix, query.entryUrlPrefix);
  }
  if (query.minDurationMs !== undefined) {
    where.push(`${durationSql} >= ?`);
    bindings.push(query.minDurationMs);
  }
  if (query.before !== undefined) {
    if (query.before.sessionId === undefined) {
      where.push(`${sortSql} < ?`);
      bindings.push(query.before.sortValue);
    } else {
      where.push(`(${sortSql} < ? OR (${sortSql} = ? AND session_id < ?))`);
      bindings.push(query.before.sortValue, query.before.sortValue, query.before.sessionId);
    }
  }

  return { where, bindings, sortSql };
}

function presenceRowComparator(
  query: Pick<PresenceHeadQuery, "sort">,
): (left: PresenceRow, right: PresenceRow) => number {
  return (left, right) => {
    const leftValue =
      query.sort === "duration" ? Math.max(0, left.last_seen - left.started_at) : left.started_at;
    const rightValue =
      query.sort === "duration"
        ? Math.max(0, right.last_seen - right.started_at)
        : right.started_at;
    return rightValue - leftValue || right.session_id.localeCompare(left.session_id);
  };
}

function addExactPresenceFilter(
  where: string[],
  bindings: Array<string | number>,
  column: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  where.push(`${column} = ?`);
  bindings.push(value);
}

type ReadJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

async function readJson(request: Request): Promise<ReadJsonResult> {
  const contentLength = readContentLength(request.headers);
  if (contentLength !== null && contentLength > MAX_PRESENCE_BODY_BYTES) {
    return { ok: false, status: 413, error: "body_too_large" };
  }

  const body = await readBodyCapped(request.body, MAX_PRESENCE_BODY_BYTES);
  if (body === null) {
    return { ok: false, status: 413, error: "body_too_large" };
  }

  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body)) as unknown };
  } catch {
    return { ok: false, status: 400, error: "request body must be JSON" };
  }
}

function readPingBody(
  input: unknown,
): { ok: true; value: ValidPresencePing } | { ok: false; error: string } {
  if (!isRecord(input)) {
    return { ok: false, error: "request body must be JSON" };
  }

  const projectId = readRequiredId(input["projectId"], "projectId");
  const sessionId = readRequiredId(input["sessionId"], "sessionId");
  const orgId = readOptionalId(input["orgId"], "orgId");
  const startedAt = readFiniteNumber(input["startedAt"]);
  const lastSeen = readFiniteNumber(input["lastSeen"]);
  if (!projectId.ok) return { ok: false, error: projectId.error };
  if (!sessionId.ok) return { ok: false, error: sessionId.error };
  if (!orgId.ok) return { ok: false, error: orgId.error };
  if (startedAt === null) return { ok: false, error: "startedAt must be a number" };
  if (lastSeen === null) return { ok: false, error: "lastSeen must be a number" };

  const entryUrl = readOptionalString(input["entryUrl"], "entryUrl", MAX_PRESENCE_TEXT_CHARS);
  const country = readOptionalString(input["country"], "country", MAX_PRESENCE_TEXT_CHARS);
  const region = readOptionalString(input["region"], "region", MAX_PRESENCE_TEXT_CHARS);
  const city = readOptionalString(input["city"], "city", MAX_PRESENCE_TEXT_CHARS);
  const browser = readOptionalString(input["browser"], "browser", MAX_PRESENCE_TEXT_CHARS);
  const os = readOptionalString(input["os"], "os", MAX_PRESENCE_TEXT_CHARS);
  const device = readOptionalString(input["device"], "device", MAX_PRESENCE_TEXT_CHARS);
  if (!entryUrl.ok) return { ok: false, error: entryUrl.error };
  if (!country.ok) return { ok: false, error: country.error };
  if (!region.ok) return { ok: false, error: region.error };
  if (!city.ok) return { ok: false, error: city.error };
  if (!browser.ok) return { ok: false, error: browser.error };
  if (!os.ok) return { ok: false, error: os.error };
  if (!device.ok) return { ok: false, error: device.error };
  const flags = input["flags"] === undefined ? 0 : readFiniteNumber(input["flags"]);
  if (flags === null || flags < 0) return { ok: false, error: "flags must be a positive number" };
  const suppliedExpiresAt =
    input["expiresAt"] === undefined ? null : readFiniteNumber(input["expiresAt"]);
  if (
    input["expiresAt"] !== undefined &&
    (suppliedExpiresAt === null ||
      suppliedExpiresAt < lastSeen ||
      suppliedExpiresAt > lastSeen + MAX_RETENTION_MS)
  ) {
    return { ok: false, error: "expiresAt must be within 365 days after lastSeen" };
  }
  const expiresAt = suppliedExpiresAt ?? lastSeen + MAX_RETENTION_MS;

  return {
    ok: true,
    value: {
      projectId: projectId.value,
      sessionId: sessionId.value,
      orgId: orgId.value,
      startedAt,
      lastSeen,
      entryUrl: entryUrl.value,
      country: country.value,
      region: region.value,
      city: city.value,
      browser: browser.value,
      os: os.value,
      device: device.value,
      flags,
      expiresAt,
    },
  };
}

function readFinalizingBody(
  input: unknown,
):
  | { ok: true; value: { projectId: string; sessionId: string; finalizingAt: number } }
  | { ok: false; error: string } {
  const remove = readRemoveBody(input);
  if (!remove.ok) return remove;
  const finalizingAt = isRecord(input) ? readFiniteNumber(input["finalizingAt"]) : null;
  if (finalizingAt === null || finalizingAt < 0) {
    return { ok: false, error: "finalizingAt must be a positive number" };
  }
  return { ok: true, value: { ...remove.value, finalizingAt } };
}

function readRemoveBody(
  input: unknown,
): { ok: true; value: { projectId: string; sessionId: string } } | { ok: false; error: string } {
  if (!isRecord(input)) {
    return { ok: false, error: "request body must be JSON" };
  }

  const projectId = readRequiredId(input["projectId"], "projectId");
  const sessionId = readRequiredId(input["sessionId"], "sessionId");
  if (!projectId.ok) return { ok: false, error: projectId.error };
  if (!sessionId.ok) return { ok: false, error: sessionId.error };

  return { ok: true, value: { projectId: projectId.value, sessionId: sessionId.value } };
}

function readListBody(
  input: unknown,
): { ok: true; value: { projectId: string; now: number } } | { ok: false; error: string } {
  if (!isRecord(input)) {
    return { ok: false, error: "request body must be JSON" };
  }

  const projectId = readRequiredId(input["projectId"], "projectId");
  const now = input["now"] === undefined ? Date.now() : readFiniteNumber(input["now"]);
  if (!projectId.ok) return { ok: false, error: projectId.error };
  if (now === null) return { ok: false, error: "now must be a number" };

  return { ok: true, value: { projectId: projectId.value, now } };
}

function readHeadsBody(
  input: unknown,
): { ok: true; value: ValidPresenceHeadQuery } | { ok: false; error: string } {
  const base = readListBody(input);
  if (!base.ok) return base;
  if (!isRecord(input)) return { ok: false, error: "request body must be JSON" };

  const limit =
    input["limit"] === undefined ? DEFAULT_HEAD_LIMIT : readFiniteNumber(input["limit"]);
  if (limit === null || limit < 1) {
    return { ok: false, error: "limit must be a positive number" };
  }
  const sort = input["sort"] === undefined ? "newest" : input["sort"];
  if (sort !== "newest" && sort !== "duration") {
    return { ok: false, error: "sort must be newest or duration" };
  }

  const from = readOptionalPositiveNumber(input["from"], "from");
  const to = readOptionalPositiveNumber(input["to"], "to");
  const minDurationMs = readOptionalPositiveNumber(input["minDurationMs"], "minDurationMs");
  if (!from.ok) return from;
  if (!to.ok) return to;
  if (!minDurationMs.ok) return minDurationMs;

  const country = readOptionalQueryString(input["country"], "country");
  const region = readOptionalQueryString(input["region"], "region");
  const device = readOptionalQueryString(input["device"], "device");
  const browser = readOptionalQueryString(input["browser"], "browser");
  const os = readOptionalQueryString(input["os"], "os");
  const entryUrl = readOptionalQueryString(input["entryUrl"], "entryUrl");
  const entryUrlPrefix = readOptionalQueryString(input["entryUrlPrefix"], "entryUrlPrefix");
  if (!country.ok) return country;
  if (!region.ok) return region;
  if (!device.ok) return device;
  if (!browser.ok) return browser;
  if (!os.ok) return os;
  if (!entryUrl.ok) return entryUrl;
  if (!entryUrlPrefix.ok) return entryUrlPrefix;

  const before = readPresenceHeadCursor(input["before"], sort);
  if (!before.ok) return before;
  const trackedSessionIds = readTrackedSessionIds(input["trackedSessionIds"]);
  if (!trackedSessionIds.ok) return trackedSessionIds;

  return {
    ok: true,
    value: {
      ...base.value,
      limit: Math.min(limit, MAX_HEAD_LIMIT),
      sort,
      ...(trackedSessionIds.value.length === 0
        ? {}
        : { trackedSessionIds: trackedSessionIds.value }),
      ...(before.value === undefined ? {} : { before: before.value }),
      ...(from.value === undefined ? {} : { from: from.value }),
      ...(to.value === undefined ? {} : { to: to.value }),
      ...(country.value === undefined ? {} : { country: country.value }),
      ...(region.value === undefined ? {} : { region: region.value }),
      ...(device.value === undefined ? {} : { device: device.value }),
      ...(browser.value === undefined ? {} : { browser: browser.value }),
      ...(os.value === undefined ? {} : { os: os.value }),
      ...(entryUrl.value === undefined ? {} : { entryUrl: entryUrl.value }),
      ...(entryUrlPrefix.value === undefined ? {} : { entryUrlPrefix: entryUrlPrefix.value }),
      ...(minDurationMs.value === undefined ? {} : { minDurationMs: minDurationMs.value }),
    },
  };
}

function readTrackedSessionIds(
  value: unknown,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > MAX_TRACKED_HEADS) {
    return { ok: false, error: "trackedSessionIds must contain at most 100 session ids" };
  }
  const sessionIds: string[] = [];
  for (const valueSessionId of value) {
    const sessionId = readRequiredId(valueSessionId, "trackedSessionIds item");
    if (!sessionId.ok) return sessionId;
    sessionIds.push(sessionId.value);
  }
  return { ok: true, value: [...new Set(sessionIds)] };
}

function readPresenceHeadCursor(
  value: unknown,
  sort: PresenceHeadSort,
): { ok: true; value: PresenceHeadCursor | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (!isRecord(value)) return { ok: false, error: "before must be an object" };

  const sortValue = readFiniteNumber(value["sortValue"]);
  if (sortValue === null || sortValue < 0) {
    return { ok: false, error: "before.sortValue must be zero or positive" };
  }
  const rawSessionId = value["sessionId"];
  if (rawSessionId === undefined && sort === "newest") {
    return { ok: true, value: { sortValue } };
  }
  const sessionId = readRequiredId(rawSessionId, "before.sessionId");
  if (!sessionId.ok) return sessionId;
  return { ok: true, value: { sortValue, sessionId: sessionId.value } };
}

function readOptionalPositiveNumber(
  value: unknown,
  name: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  const parsed = readFiniteNumber(value);
  if (parsed === null || parsed < 0) {
    return { ok: false, error: `${name} must be zero or positive` };
  }
  return { ok: true, value: parsed };
}

function readOptionalQueryString(
  value: unknown,
  name: string,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  const parsed = readOptionalString(value, name, MAX_PRESENCE_TEXT_CHARS);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value ?? undefined };
}

function readHeadBody(
  input: unknown,
):
  | { ok: true; value: { projectId: string; sessionId: string; now: number } }
  | { ok: false; error: string } {
  const remove = readRemoveBody(input);
  if (!remove.ok) return remove;
  const now =
    isRecord(input) && input["now"] !== undefined ? readFiniteNumber(input["now"]) : Date.now();
  if (now === null) return { ok: false, error: "now must be a number" };
  return { ok: true, value: { ...remove.value, now } };
}

function readRequiredId(
  value: unknown,
  name: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: `${name} is required` };
  }

  if (value.length > MAX_PRESENCE_ID_CHARS || !ID_PATTERN.test(value)) {
    return {
      ok: false,
      error: `${name} must be 1 to ${MAX_PRESENCE_ID_CHARS} letters, numbers, underscores, or dashes`,
    };
  }

  return { ok: true, value };
}

function readOptionalId(
  value: unknown,
  name: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: null };
  }
  return readRequiredId(value, name);
}

function readOptionalString(
  value: unknown,
  name: string,
  maxChars: number,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: null };
  }

  if (typeof value !== "string") {
    return { ok: false, error: `${name} must be a string` };
  }

  if (value.length > maxChars) {
    return { ok: false, error: `${name} must be at most ${maxChars} characters` };
  }

  return { ok: true, value };
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

function safePresenceRoute(pathname: string): string {
  if (pathname === "/ping") return "ping";
  if (pathname === "/remove") return "remove";
  if (pathname === "/mark-finalizing") return "mark_finalizing";
  if (pathname === "/list") return "list";
  if (pathname === "/heads") return "heads";
  if (pathname === "/head") return "head";
  if (pathname === "/install-status") return "install_status";
  if (pathname === "/debug") return "debug";
  return "not_found";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: {
      ...JSON_SECURITY_HEADERS,
      ...Object.fromEntries(new Headers(init?.headers).entries()),
    },
  });
}

function readContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null || !/^[0-9]+$/.test(raw)) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<Uint8Array | null> {
  if (body === null) {
    return new Uint8Array(0);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
