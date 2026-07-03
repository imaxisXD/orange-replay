import {
  HDR_REQUEST_ID,
  manifestKey,
  sessionPrefix,
  startWideEvent,
  uuidv7,
} from "@orange-replay/shared";
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
    const response = await routeRequest(request, url, env, ctx, wideEvent);
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

function proxyLiveSession(
  request: Request,
  env: Env,
  projectId: string,
  sessionId: string,
): Response | Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return jsonError("websocket_required", 426, { upgrade: "websocket" });
  }

  // TODO: jurisdiction-pinned sessions need the project's jurisdiction from config to resolve the same DO id (control-plane lookup, T3.2).
  const stub = env.SESSION.get(env.SESSION.idFromName(`${projectId}:${sessionId}`));
  return stub.fetch(request);
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
