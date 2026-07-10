import { manifestKey, sessionPrefix, startWideEvent } from "@orange-replay/shared";
import { shardDb, type Env } from "../env.ts";
import type { ApiAuthMode } from "./auth.ts";
import {
  buildSessionsQuery,
  encodeSessionCursor,
  parseSessionListQuery,
  type SessionRow,
} from "./helpers.ts";
import { jsonError, jsonResponse, secureHeaders, withSecurityHeaders } from "./http.ts";

const DEMO_SESSIONS_LIST_MAX = 50;

export async function listSessions(
  url: URL,
  env: Env,
  projectId: string,
  authMode: ApiAuthMode,
): Promise<Response> {
  const parsed = parseSessionListQuery(url.searchParams);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  const options =
    authMode === "demo" && parsed.options.limit > DEMO_SESSIONS_LIST_MAX
      ? { ...parsed.options, limit: DEMO_SESSIONS_LIST_MAX }
      : parsed.options;
  const query = buildSessionsQuery(projectId, options);
  const result = await shardDb(env, 0)
    .prepare(query.sql)
    .bind(...query.bindings)
    .all<SessionRow>();
  const sessions = result.results ?? [];
  const lastSession = sessions.at(-1);
  // A short page means the list is exhausted — no cursor, so clients can
  // render an honest count instead of a dangling "load more".
  const hasMore = lastSession !== undefined && sessions.length >= options.limit;

  return jsonResponse({
    sessions,
    nextBefore: hasMore ? encodeSessionCursor(lastSession, options.sort) : null,
  });
}

export async function getManifest(
  env: Env,
  projectId: string,
  sessionId: string,
): Promise<Response> {
  if (!(await sessionIsReadable(env, projectId, sessionId))) {
    return jsonError("not_found", 404);
  }

  const object = await env.RECORDINGS.get(manifestKey(projectId, sessionId));
  if (object === null) return jsonError("not_found", 404);

  return new Response(object.body, {
    headers: secureHeaders({
      "content-type": "application/json",
      // Manifests are written once at finalize and never mutate (immutable
      // R2 create-only PUT), so they are as cacheable as segments.
      "cache-control": "private, max-age=31536000, immutable",
      vary: "Authorization",
    }),
  });
}

export async function getSegment(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  projectId: string,
  sessionId: string,
  name: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  if (!(await sessionIsReadable(env, projectId, sessionId))) {
    return jsonError("not_found", 404);
  }

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
      vary: "Authorization",
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

async function sessionIsReadable(env: Env, projectId: string, sessionId: string): Promise<boolean> {
  const row = await shardDb(env, 0)
    .prepare(
      `SELECT 1
        FROM sessions
        WHERE project_id = ?
          AND session_id = ?
          AND NOT EXISTS (
            SELECT 1
            FROM session_deletions d
            WHERE d.project_id = sessions.project_id
              AND d.session_id = sessions.session_id
          )
        LIMIT 1`,
    )
    .bind(projectId, sessionId)
    .first();
  return row !== null;
}
