import {
  HDR_REQUEST_ID,
  MAX_PRESENCE_BODY_BYTES,
  MAX_PRESENCE_ID_CHARS,
  MAX_PRESENCE_TEXT_CHARS,
  startWideEvent,
} from "@orange-replay/shared";
import type { WideEventOutcome } from "@orange-replay/shared";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { resolvePresenceTiming } from "./presence-logic.ts";
import type { PresenceSession } from "./presence-logic.ts";

type SqlRowValue = string | number | null;

const JSON_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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
  private firstEventSeeded = false;

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
      const response = jsonResponse({ error: "presence registry failed" }, { status: 500 });
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

    if (request.method === "POST" && url.pathname === "/list") {
      const json = await readJson(request);
      if (!json.ok) return jsonResponse({ error: json.error }, { status: json.status });
      const body = readListBody(json.value);
      if (!body.ok) return jsonResponse({ error: body.error }, { status: 400 });
      event.set({ project_id: body.value.projectId, route: "list" });
      return jsonResponse({
        sessions: this.list(body.value.now),
      });
    }

    if (request.method === "POST" && url.pathname === "/install-status") {
      const json = await readJson(request);
      if (!json.ok) return jsonResponse({ error: json.error }, { status: json.status });
      const body = readListBody(json.value);
      if (!body.ok) return jsonResponse({ error: body.error }, { status: 400 });
      event.set({ project_id: body.value.projectId, route: "install_status" });
      return jsonResponse({ firstEventAt: this.firstEventAt() });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/debug" &&
      this.env.DEV_TEST_ROUTES === "1"
    ) {
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
  const startedAt = readFiniteNumber(input["startedAt"]);
  const lastSeen = readFiniteNumber(input["lastSeen"]);
  if (!projectId.ok) return { ok: false, error: projectId.error };
  if (!sessionId.ok) return { ok: false, error: sessionId.error };
  if (startedAt === null) return { ok: false, error: "startedAt must be a number" };
  if (lastSeen === null) return { ok: false, error: "lastSeen must be a number" };

  const entryUrl = readOptionalString(input["entryUrl"], "entryUrl", MAX_PRESENCE_TEXT_CHARS);
  const country = readOptionalString(input["country"], "country", MAX_PRESENCE_TEXT_CHARS);
  const city = readOptionalString(input["city"], "city", MAX_PRESENCE_TEXT_CHARS);
  const browser = readOptionalString(input["browser"], "browser", MAX_PRESENCE_TEXT_CHARS);
  const os = readOptionalString(input["os"], "os", MAX_PRESENCE_TEXT_CHARS);
  const device = readOptionalString(input["device"], "device", MAX_PRESENCE_TEXT_CHARS);
  if (!entryUrl.ok) return { ok: false, error: entryUrl.error };
  if (!country.ok) return { ok: false, error: country.error };
  if (!city.ok) return { ok: false, error: city.error };
  if (!browser.ok) return { ok: false, error: browser.error };
  if (!os.ok) return { ok: false, error: os.error };
  if (!device.ok) return { ok: false, error: device.error };

  return {
    ok: true,
    value: {
      projectId: projectId.value,
      sessionId: sessionId.value,
      startedAt,
      lastSeen,
      entryUrl: entryUrl.value,
      country: country.value,
      city: city.value,
      browser: browser.value,
      os: os.value,
      device: device.value,
    },
  };
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
