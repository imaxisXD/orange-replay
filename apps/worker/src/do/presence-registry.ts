import { HDR_REQUEST_ID, startWideEvent } from "@orange-replay/shared";
import type { WideEventOutcome } from "@orange-replay/shared";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { resolvePresenceTiming } from "./presence-logic.ts";
import type { PresenceSession } from "./presence-logic.ts";

type SqlRowValue = string | number | null;

interface PresenceRow {
  [key: string]: SqlRowValue;
  session_id: string;
  started_at: number;
  last_seen: number;
  entry_url: string | null;
  country: string | null;
  city: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
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
  startedAt: number;
  lastSeen: number;
  entryUrl: string | null;
  country: string | null;
  city: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
}

export class PresenceRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.createSchema();
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get(HDR_REQUEST_ID) ?? crypto.randomUUID();
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
      const response = Response.json({ error: "presence registry failed" }, { status: 500 });
      statusCode = response.status;
      return response;
    } finally {
      event.set({ status_code: statusCode });
      event.emit(outcome);
    }
  }

  private async routeRequest(
    request: Request,
    url: URL,
    event: ReturnType<typeof startWideEvent>,
  ): Promise<Response> {
    if (request.method === "POST" && url.pathname === "/ping") {
      const body = readPingBody(await readJson(request));
      if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
      event.set({
        project_id: body.value.projectId,
        session_id: body.value.sessionId,
        route: "ping",
      });
      this.ping(body.value);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/remove") {
      const body = readRemoveBody(await readJson(request));
      if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
      event.set({
        project_id: body.value.projectId,
        session_id: body.value.sessionId,
        route: "remove",
      });
      this.remove(body.value.sessionId);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/list") {
      const body = readListBody(await readJson(request));
      if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
      event.set({ project_id: body.value.projectId, route: "list" });
      return Response.json({
        sessions: this.list(body.value.now),
      });
    }

    if (request.method === "POST" && url.pathname === "/install-status") {
      const body = readListBody(await readJson(request));
      if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
      event.set({ project_id: body.value.projectId, route: "install_status" });
      return Response.json({ firstEventAt: this.firstEventAt() });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/debug" &&
      this.env.DEV_TEST_ROUTES === "1"
    ) {
      const body = readListBody(await readJson(request));
      if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
      event.set({ project_id: body.value.projectId, route: "debug" });
      return Response.json({
        rows: this.countRows(),
        firstEventAt: this.firstEventAt(),
      });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private createSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS presence (
        session_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        entry_url TEXT,
        country TEXT,
        city TEXT,
        browser TEXT,
        os TEXT,
        device TEXT
      );
      CREATE TABLE IF NOT EXISTS project_meta (
        k TEXT PRIMARY KEY,
        v TEXT
      );
    `);
  }

  private ping(input: {
    sessionId: string;
    startedAt: number;
    lastSeen: number;
    entryUrl: string | null;
    country: string | null;
    city: string | null;
    browser: string | null;
    os: string | null;
    device: string | null;
  }): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO project_meta (k, v)
        VALUES ('first_event_at', ?)`,
      String(input.lastSeen),
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO presence
        (session_id, started_at, last_seen, entry_url, country, city, browser, os, device)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          last_seen = excluded.last_seen,
          entry_url = COALESCE(excluded.entry_url, presence.entry_url),
          country = COALESCE(excluded.country, presence.country),
          city = COALESCE(excluded.city, presence.city),
          browser = COALESCE(excluded.browser, presence.browser),
          os = COALESCE(excluded.os, presence.os),
          device = COALESCE(excluded.device, presence.device)`,
      input.sessionId,
      input.startedAt,
      input.lastSeen,
      input.entryUrl,
      input.country,
      input.city,
      input.browser,
      input.os,
      input.device,
    );
  }

  private remove(sessionId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM presence WHERE session_id = ?", sessionId);
  }

  private list(now: number): PresenceSession[] {
    const ttl = resolvePresenceTiming(this.env.DEV_TEST_ROUTES, this.env.TEST_TIMINGS).ttlMs;
    const cutoff = now - ttl;
    this.ctx.storage.sql.exec("DELETE FROM presence WHERE last_seen < ?", cutoff);

    return this.ctx.storage.sql
      .exec<PresenceRow>(
        `SELECT session_id, started_at, last_seen, entry_url, country, city, browser, os, device
          FROM presence
          WHERE last_seen >= ?
          ORDER BY last_seen DESC, session_id ASC`,
        cutoff,
      )
      .toArray()
      .map((row) => ({
        session_id: row.session_id,
        started_at: row.started_at,
        last_seen: row.last_seen,
        entry_url: row.entry_url,
        country: row.country,
        city: row.city,
        browser: row.browser,
        os: row.os,
        device: row.device,
      }));
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

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function readPingBody(
  input: unknown,
): { ok: true; value: ValidPresencePing } | { ok: false; error: string } {
  if (!isRecord(input)) {
    return { ok: false, error: "request body must be JSON" };
  }

  const projectId = readRequiredString(input["projectId"]);
  const sessionId = readRequiredString(input["sessionId"]);
  const startedAt = readFiniteNumber(input["startedAt"]);
  const lastSeen = readFiniteNumber(input["lastSeen"]);
  if (projectId === null) return { ok: false, error: "projectId is required" };
  if (sessionId === null) return { ok: false, error: "sessionId is required" };
  if (startedAt === null) return { ok: false, error: "startedAt must be a number" };
  if (lastSeen === null) return { ok: false, error: "lastSeen must be a number" };

  return {
    ok: true,
    value: {
      projectId,
      sessionId,
      startedAt,
      lastSeen,
      entryUrl: readOptionalString(input["entryUrl"]),
      country: readOptionalString(input["country"]),
      city: readOptionalString(input["city"]),
      browser: readOptionalString(input["browser"]),
      os: readOptionalString(input["os"]),
      device: readOptionalString(input["device"]),
    },
  };
}

function readRemoveBody(
  input: unknown,
): { ok: true; value: { projectId: string; sessionId: string } } | { ok: false; error: string } {
  if (!isRecord(input)) {
    return { ok: false, error: "request body must be JSON" };
  }

  const projectId = readRequiredString(input["projectId"]);
  const sessionId = readRequiredString(input["sessionId"]);
  if (projectId === null) return { ok: false, error: "projectId is required" };
  if (sessionId === null) return { ok: false, error: "sessionId is required" };

  return { ok: true, value: { projectId, sessionId } };
}

function readListBody(
  input: unknown,
): { ok: true; value: { projectId: string; now: number } } | { ok: false; error: string } {
  if (!isRecord(input)) {
    return { ok: false, error: "request body must be JSON" };
  }

  const projectId = readRequiredString(input["projectId"]);
  const now = input["now"] === undefined ? Date.now() : readFiniteNumber(input["now"]);
  if (projectId === null) return { ok: false, error: "projectId is required" };
  if (now === null) return { ok: false, error: "now must be a number" };

  return { ok: true, value: { projectId, now } };
}

function readRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
