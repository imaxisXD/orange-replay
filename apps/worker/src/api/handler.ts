import {
  HDR_REQUEST_ID,
  LIVE_TICKET_TTL_MS,
  MAX_CONFIG_UPDATE_BODY_BYTES,
  manifestKey,
  sessionPrefix,
  startWideEvent,
  uuidv7,
} from "@orange-replay/shared";
import type { LiveTicketResponse } from "@orange-replay/shared";
import type { PresenceSession } from "../do/presence-logic.ts";
import { liveSessionsFromPresenceRows } from "../do/presence-logic.ts";
import { shardDb, type Env } from "../env.ts";
import { readBodyCapped, readContentLength } from "../ingest/helpers.ts";
import {
  buildSessionsQuery,
  encodeSessionCursor,
  isValidPathId,
  isValidSegmentName,
  outcomeForStatus,
  parseSessionListQuery,
  type SessionRow,
} from "./helpers.ts";
import {
  parseProjectConfigUpdate,
  readProjectKeys,
  readStoredProjectConfig,
  writeStoredProjectConfig,
} from "./project-config.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LIVE_AUTH_HEADER = "x-or-live-auth";
const API_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

export async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const requestId = request.headers.get(HDR_REQUEST_ID) ?? uuidv7();
  const route = routeName(url.pathname);
  const wideEvent = startWideEvent("worker", "api.request", requestId);
  let statusCode = 500;

  wideEvent.set({ route });

  try {
    const response = await routeRequest(request, url, env, ctx, wideEvent, requestId);
    statusCode = response.status;
    return response;
  } catch (err) {
    wideEvent.fail(err);
    const response = jsonError("internal_error", 500);
    statusCode = response.status;
    return response;
  } finally {
    wideEvent.set({ status_code: statusCode });
    wideEvent.emit(outcomeForStatus(statusCode));
  }
}

async function routeRequest(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  wideEvent: ReturnType<typeof startWideEvent>,
  requestId: string,
): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/v1/health") {
    return jsonResponse({ ok: true });
  }

  const liveMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/live$/.exec(url.pathname);
  if (request.method === "GET" && liveMatch) {
    const ids = parseProjectSessionIds(liveMatch);
    if (!ids.ok) return jsonError("invalid_path_id", 400);
    wideEvent.set({ project_id: ids.projectId, session_id: ids.sessionId, auth: "ticket" });
    return proxyLiveSession(request, url, env, ids.projectId, ids.sessionId, requestId);
  }

  const auth = await checkAuth(request, env);
  if (!auth.ok) return jsonError(auth.error, auth.status);

  const sessionsMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions$/.exec(url.pathname);
  if (request.method === "GET" && sessionsMatch) {
    const projectId = sessionsMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    wideEvent.set({ project_id: projectId });
    return listSessions(url, env, projectId);
  }

  const projectLiveMatch = /^\/api\/v1\/projects\/([^/]+)\/live$/.exec(url.pathname);
  if (request.method === "GET" && projectLiveMatch) {
    const projectId = projectLiveMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    wideEvent.set({ project_id: projectId });
    return listLiveSessions(env, projectId, requestId);
  }

  const configMatch = /^\/api\/v1\/projects\/([^/]+)\/config$/.exec(url.pathname);
  if (configMatch) {
    const projectId = configMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    wideEvent.set({ project_id: projectId });
    if (request.method === "GET") return getProjectConfig(env, projectId);
    if (request.method === "PUT") return putProjectConfig(request, env, projectId, wideEvent);
  }

  const installStatusMatch = /^\/api\/v1\/projects\/([^/]+)\/install-status$/.exec(url.pathname);
  if (request.method === "GET" && installStatusMatch) {
    const projectId = installStatusMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    wideEvent.set({ project_id: projectId });
    return getInstallStatus(env, projectId, requestId);
  }

  const keysMatch = /^\/api\/v1\/projects\/([^/]+)\/keys$/.exec(url.pathname);
  if (request.method === "GET" && keysMatch) {
    const projectId = keysMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    wideEvent.set({ project_id: projectId });
    return getProjectKeys(env, projectId, wideEvent);
  }

  const manifestMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/manifest$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && manifestMatch) {
    const ids = parseProjectSessionIds(manifestMatch);
    if (!ids.ok) return jsonError("invalid_path_id", 400);
    wideEvent.set({ project_id: ids.projectId, session_id: ids.sessionId });
    return getManifest(env, ids.projectId, ids.sessionId);
  }

  const liveTicketMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/live-ticket$/.exec(
    url.pathname,
  );
  if (request.method === "POST" && liveTicketMatch) {
    const ids = parseProjectSessionIds(liveTicketMatch);
    if (!ids.ok) return jsonError("invalid_path_id", 400);
    wideEvent.set({ project_id: ids.projectId, session_id: ids.sessionId });
    return mintLiveTicket(env, ids.projectId, ids.sessionId);
  }

  const segmentMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/segments\/(.+)$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && segmentMatch) {
    const ids = parseProjectSessionIds(segmentMatch);
    if (!ids.ok) return jsonError("invalid_path_id", 400);

    const name = segmentMatch[3];
    if (!name || !isValidSegmentName(name)) return jsonError("invalid_segment_name", 400);

    wideEvent.set({
      project_id: ids.projectId,
      session_id: ids.sessionId,
      cache_hit: false,
    });
    return getSegment(request, env, ctx, ids.projectId, ids.sessionId, name, wideEvent);
  }

  return jsonError("not_found", 404);
}

async function listLiveSessions(env: Env, projectId: string, requestId: string): Promise<Response> {
  const now = Date.now();
  const response = await fetchPresence(env, projectId, "/list", requestId, { projectId, now });
  if (!response.ok) return jsonError("presence_unavailable", 503);
  const body = (await response.json()) as { sessions?: PresenceSession[] };
  return jsonResponse({
    sessions: liveSessionsFromPresenceRows(body.sessions ?? [], now),
  });
}

async function getProjectConfig(env: Env, projectId: string): Promise<Response> {
  const config = await readStoredProjectConfig(env, projectId);
  if (config === null) return jsonError("not_found", 404);
  return jsonResponse(config);
}

async function putProjectConfig(
  request: Request,
  env: Env,
  projectId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  const body = await readJsonBodyCapped(request, MAX_CONFIG_UPDATE_BODY_BYTES);
  if (!body.ok) return jsonError(body.error, body.status);

  const parsed = parseProjectConfigUpdate(body.value);
  if (!parsed.ok) {
    return jsonError(parsed.error, 400);
  }

  const config = await writeStoredProjectConfig(env, projectId, parsed.value);
  if (config === null) return jsonError("not_found", 404);

  wideEvent.set({ config_version: config.version });
  return jsonResponse(config);
}

async function getInstallStatus(env: Env, projectId: string, requestId: string): Promise<Response> {
  const response = await fetchPresence(env, projectId, "/install-status", requestId, {
    projectId,
  });
  if (!response.ok) return jsonError("presence_unavailable", 503);
  return jsonResponse(await response.json());
}

async function getProjectKeys(
  env: Env,
  projectId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  const keys = await readProjectKeys(env, projectId);
  wideEvent.set({ key_count: keys.length });
  return jsonResponse({ keys });
}

async function listSessions(url: URL, env: Env, projectId: string): Promise<Response> {
  const parsed = parseSessionListQuery(url.searchParams);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  const query = buildSessionsQuery(projectId, parsed.options);
  const result = await shardDb(env, 0)
    .prepare(query.sql)
    .bind(...query.bindings)
    .all<SessionRow>();
  const sessions = result.results ?? [];
  const lastSession = sessions.at(-1);

  return jsonResponse({
    sessions,
    nextBefore: lastSession === undefined ? null : encodeSessionCursor(lastSession),
  });
}

async function getManifest(env: Env, projectId: string, sessionId: string): Promise<Response> {
  const object = await env.RECORDINGS.get(manifestKey(projectId, sessionId));
  if (object === null) return jsonError("not_found", 404);

  return new Response(object.body, {
    headers: secureHeaders({
      "content-type": "application/json",
      "cache-control": "no-store",
    }),
  });
}

async function getSegment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  projectId: string,
  sessionId: string,
  name: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  try {
    const cached = await caches.default.match(request);
    if (cached !== undefined) {
      wideEvent.set({ cache_hit: true });
      return withSecurityHeaders(cached);
    }
  } catch {
    wideEvent.set({ cache_hit: false });
  }

  const object = await env.RECORDINGS.get(`${sessionPrefix(projectId, sessionId)}/${name}`);
  if (object === null) return jsonError("not_found", 404);

  const response = new Response(object.body, {
    headers: secureHeaders({
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      etag: object.httpEtag,
    }),
  });

  try {
    ctx.waitUntil(caches.default.put(request, response.clone()).catch(() => undefined));
  } catch {
    wideEvent.set({ cache_hit: false });
  }

  return response;
}

async function proxyLiveSession(
  request: Request,
  url: URL,
  env: Env,
  projectId: string,
  sessionId: string,
  requestId: string,
): Promise<Response> {
  const ticket = await verifyLiveTicketRequest(url, env, projectId, sessionId);
  if (!ticket.ok) return jsonError("unauthorized", 401);

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return jsonError("websocket_required", 426, { upgrade: "websocket" });
  }

  const config = await readStoredProjectConfig(env, projectId);
  if (config === null) return jsonError("not_found", 404);

  const namespace = config.jurisdiction
    ? env.SESSION.jurisdiction(config.jurisdiction)
    : env.SESSION;
  const stub = namespace.get(namespace.idFromName(`${projectId}:${sessionId}`));
  const headers = new Headers(request.headers);
  headers.set(HDR_REQUEST_ID, requestId);
  headers.set(LIVE_AUTH_HEADER, "ticket");
  const response = await stub.fetch(new Request(request, { headers }));
  return response.status === 101 ? response : withSecurityHeaders(response);
}

async function fetchPresence(
  env: Env,
  projectId: string,
  path: "/list" | "/install-status",
  requestId: string,
  body: unknown,
): Promise<Response> {
  const stub = env.PRESENCE.get(env.PRESENCE.idFromName(projectId));
  return await stub.fetch(`https://presence.internal${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HDR_REQUEST_ID]: requestId,
    },
    body: JSON.stringify(body),
  });
}

async function checkAuth(
  request: Request,
  env: Env,
): Promise<{ ok: true } | { ok: false; status: 401 | 503; error: string }> {
  if (!env.DEV_API_TOKEN) {
    return { ok: false, status: 503, error: "auth_not_configured" };
  }

  const header = request.headers.get("authorization");
  const prefix = "Bearer ";
  let actualToken: string | null = null;

  if (header !== null) {
    if (!header.startsWith(prefix)) {
      return { ok: false, status: 401, error: "unauthorized" };
    }
    actualToken = header.slice(prefix.length);
  }

  if (actualToken === null) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const expected = encoder.encode(env.DEV_API_TOKEN);
  const actual = encoder.encode(actualToken);
  if (expected.byteLength !== actual.byteLength) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  if (!timingSafeEqual(expected, actual)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  return { ok: true };
}

function parseProjectSessionIds(
  match: RegExpExecArray,
): { ok: true; projectId: string; sessionId: string } | { ok: false } {
  const projectId = match[1];
  const sessionId = match[2];
  if (!projectId || !sessionId || !isValidPathId(projectId) || !isValidPathId(sessionId)) {
    return { ok: false };
  }
  return { ok: true, projectId, sessionId };
}

function routeName(pathname: string): string {
  if (pathname === "/api/v1/health") return "health";
  if (/^\/api\/v1\/projects\/[^/]+\/sessions$/.test(pathname)) return "sessions_list";
  if (/^\/api\/v1\/projects\/[^/]+\/live$/.test(pathname)) return "project_live";
  if (/^\/api\/v1\/projects\/[^/]+\/config$/.test(pathname)) return "project_config";
  if (/^\/api\/v1\/projects\/[^/]+\/install-status$/.test(pathname)) {
    return "install_status";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/keys$/.test(pathname)) return "project_keys";
  if (/^\/api\/v1\/projects\/[^/]+\/sessions\/[^/]+\/manifest$/.test(pathname)) {
    return "manifest";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/sessions\/[^/]+\/live-ticket$/.test(pathname)) {
    return "live_ticket";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/sessions\/[^/]+\/segments\/.+$/.test(pathname)) {
    return "segment";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/sessions\/[^/]+\/live$/.test(pathname)) return "live";
  return "not_found";
}

async function mintLiveTicket(env: Env, projectId: string, sessionId: string): Promise<Response> {
  if (env.DEV_API_TOKEN === undefined) {
    return jsonError("auth_not_configured", 503);
  }

  const expiresAt = Date.now() + LIVE_TICKET_TTL_MS;
  const signature = await signLiveTicket(env.DEV_API_TOKEN, projectId, sessionId, expiresAt);
  const ticketBody = `${expiresAt}.${base64UrlEncode(signature)}`;
  return jsonResponse({
    ticket: base64UrlEncode(encoder.encode(ticketBody)),
    expiresAt,
  } satisfies LiveTicketResponse);
}

async function verifyLiveTicketRequest(
  url: URL,
  env: Env,
  projectId: string,
  sessionId: string,
): Promise<{ ok: true } | { ok: false }> {
  if (url.searchParams.has("token")) {
    return { ok: false };
  }

  const ticket = url.searchParams.get("ticket");
  if (ticket === null || ticket.length === 0 || env.DEV_API_TOKEN === undefined) {
    return { ok: false };
  }

  const decoded = base64UrlDecode(ticket);
  if (decoded === null) return { ok: false };

  const body = decoder.decode(decoded);
  const separator = body.indexOf(".");
  if (separator < 1 || separator === body.length - 1) {
    return { ok: false };
  }

  const expiresAt = Number(body.slice(0, separator));
  const signature = base64UrlDecode(body.slice(separator + 1));
  if (!Number.isSafeInteger(expiresAt) || signature === null || Date.now() > expiresAt) {
    return { ok: false };
  }

  const key = await liveTicketKey(env.DEV_API_TOKEN, ["verify"]);
  const message = liveTicketMessage(projectId, sessionId, expiresAt);
  const ok = await crypto.subtle.verify("HMAC", key, signature, message);
  return ok ? { ok: true } : { ok: false };
}

async function signLiveTicket(
  apiToken: string,
  projectId: string,
  sessionId: string,
  expiresAt: number,
): Promise<Uint8Array> {
  const key = await liveTicketKey(apiToken, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    liveTicketMessage(projectId, sessionId, expiresAt),
  );
  return new Uint8Array(signature);
}

function liveTicketMessage(projectId: string, sessionId: string, expiresAt: number): Uint8Array {
  return encoder.encode(`${projectId}:${sessionId}:${expiresAt}`);
}

function liveTicketKey(apiToken: string, usages: Array<"sign" | "verify">): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(apiToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

async function readJsonBodyCapped(
  request: Request,
  cap: number,
): Promise<
  | { ok: true; value: unknown }
  | {
      ok: false;
      status: 400 | 413;
      error: "invalid_content_length" | "body_too_large" | "invalid_json";
    }
> {
  const contentLength = readContentLength(request.headers);
  if (contentLength.ok && contentLength.value > cap) {
    return { ok: false, status: 413, error: "body_too_large" };
  }
  if (!contentLength.ok && contentLength.malformed) {
    return { ok: false, status: 400, error: "invalid_content_length" };
  }

  const bodyBytes = await readBodyCapped(request.body, cap);
  if (bodyBytes === null) {
    return { ok: false, status: 413, error: "body_too_large" };
  }

  try {
    return { ok: true, value: JSON.parse(decoder.decode(bodyBytes)) as unknown };
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
}

function jsonError(error: string, status: number, headers?: HeadersInit): Response {
  return jsonResponse({ error }, { status, headers });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: secureHeaders(init?.headers),
  });
}

function secureHeaders(headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    next.set(name, value);
  }
  return next;
}

function withSecurityHeaders(response: Response): Response {
  const headers = secureHeaders(response.headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }

  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");

  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}
