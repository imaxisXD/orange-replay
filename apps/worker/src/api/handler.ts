import {
  HDR_REQUEST_ID,
  manifestKey,
  sessionPrefix,
  startWideEvent,
  uuidv7,
} from "@orange-replay/shared";
import type { PresenceSession } from "../do/presence-logic.ts";
import { liveSessionsFromPresenceRows } from "../do/presence-logic.ts";
import { shardDb, type Env } from "../env.ts";
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
  readStoredProjectConfig,
  writeStoredProjectConfig,
} from "./project-config.ts";

const encoder = new TextEncoder();

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
    return Response.json({ ok: true });
  }

  const auth = await checkAuth(request, url, env);
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

  const manifestMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/manifest$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && manifestMatch) {
    const ids = parseProjectSessionIds(manifestMatch);
    if (!ids.ok) return jsonError("invalid_path_id", 400);
    wideEvent.set({ project_id: ids.projectId, session_id: ids.sessionId });
    return getManifest(env, ids.projectId, ids.sessionId);
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

  const liveMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/live$/.exec(url.pathname);
  if (request.method === "GET" && liveMatch) {
    const ids = parseProjectSessionIds(liveMatch);
    if (!ids.ok) return jsonError("invalid_path_id", 400);
    wideEvent.set({ project_id: ids.projectId, session_id: ids.sessionId });
    return proxyLiveSession(request, env, ids.projectId, ids.sessionId);
  }

  return jsonError("not_found", 404);
}

async function listLiveSessions(env: Env, projectId: string, requestId: string): Promise<Response> {
  const now = Date.now();
  const response = await fetchPresence(env, projectId, "/list", requestId, { projectId, now });
  if (!response.ok) return jsonError("presence_unavailable", 503);
  const body = (await response.json()) as { sessions?: PresenceSession[] };
  return Response.json({
    sessions: liveSessionsFromPresenceRows(body.sessions ?? [], now),
  });
}

async function getProjectConfig(env: Env, projectId: string): Promise<Response> {
  const config = await readStoredProjectConfig(env, projectId);
  if (config === null) return jsonError("not_found", 404);
  return Response.json(config);
}

async function putProjectConfig(
  request: Request,
  env: Env,
  projectId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid_json", 400);
  }

  const parsed = parseProjectConfigUpdate(body);
  if (!parsed.ok) {
    return jsonError(parsed.error, 400);
  }

  const config = await writeStoredProjectConfig(env, projectId, parsed.value);
  if (config === null) return jsonError("not_found", 404);

  wideEvent.set({ config_version: config.version });
  return Response.json(config);
}

async function getInstallStatus(env: Env, projectId: string, requestId: string): Promise<Response> {
  const response = await fetchPresence(env, projectId, "/install-status", requestId, {
    projectId,
  });
  if (!response.ok) return jsonError("presence_unavailable", 503);
  return Response.json(await response.json());
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

  return Response.json({
    sessions,
    nextBefore: lastSession === undefined ? null : encodeSessionCursor(lastSession),
  });
}

async function getManifest(env: Env, projectId: string, sessionId: string): Promise<Response> {
  const object = await env.RECORDINGS.get(manifestKey(projectId, sessionId));
  if (object === null) return jsonError("not_found", 404);

  return new Response(object.body, {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
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
      return cached;
    }
  } catch {
    wideEvent.set({ cache_hit: false });
  }

  const object = await env.RECORDINGS.get(`${sessionPrefix(projectId, sessionId)}/${name}`);
  if (object === null) return jsonError("not_found", 404);

  const response = new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      etag: object.httpEtag,
    },
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
  env: Env,
  projectId: string,
  sessionId: string,
): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return jsonError("websocket_required", 426, { upgrade: "websocket" });
  }

  const config = await readStoredProjectConfig(env, projectId);
  if (config === null) return jsonError("not_found", 404);

  const namespace = config.jurisdiction
    ? env.SESSION.jurisdiction(config.jurisdiction)
    : env.SESSION;
  const stub = namespace.get(namespace.idFromName(`${projectId}:${sessionId}`));
  return stub.fetch(request);
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
  url: URL,
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
  } else if (isLiveRoute(url.pathname)) {
    // v1 dev-token transport for WebSocket clients — production replaces this with short-lived signed tickets minted over REST (Phase 3).
    actualToken = url.searchParams.get("token");
  }

  if (actualToken === null) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const expected = encoder.encode(env.DEV_API_TOKEN);
  const actual = encoder.encode(actualToken);
  if (expected.byteLength !== actual.byteLength) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(left: BufferSource, right: BufferSource): boolean;
  };
  if (!subtle.timingSafeEqual(expected, actual)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  return { ok: true };
}

function isLiveRoute(pathname: string): boolean {
  return /^\/api\/v1\/projects\/[^/]+\/sessions\/[^/]+\/live$/.test(pathname);
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
  if (/^\/api\/v1\/projects\/[^/]+\/sessions\/[^/]+\/manifest$/.test(pathname)) {
    return "manifest";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/sessions\/[^/]+\/segments\/.+$/.test(pathname)) {
    return "segment";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/sessions\/[^/]+\/live$/.test(pathname)) return "live";
  return "not_found";
}

function jsonError(error: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error }, { status, headers });
}
