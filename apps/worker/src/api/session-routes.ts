import {
  manifestKey,
  sessionPrefix,
  startWideEvent,
  type ListSessionsResponse,
} from "@orange-replay/shared";
import { readFinalizedSessionPage } from "../analytics/finalized-read.ts";
import type { Env } from "../env.ts";
import type { ApiAuthMode } from "./auth.ts";
import { parseSessionListQuery } from "./helpers.ts";
import { jsonError, jsonResponse, secureHeaders } from "./http.ts";
import { sessionHasDeletionFence } from "./session-head-routes.ts";

const DEMO_SESSIONS_LIST_MAX = 50;

export async function listSessions(
  url: URL,
  env: Env,
  projectId: string,
  authMode: ApiAuthMode,
  requestId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
  ctx: ExecutionContext,
): Promise<Response> {
  const parsed = parseSessionListQuery(url.searchParams);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  const requestedOptions =
    authMode === "demo" && parsed.options.limit > DEMO_SESSIONS_LIST_MAX
      ? { ...parsed.options, limit: DEMO_SESSIONS_LIST_MAX }
      : parsed.options;
  const result = await readFinalizedSessionPage({
    env,
    projectId,
    requestedOptions,
    requestId,
    wideEvent,
    ctx,
    now: Date.now(),
  });
  if (!result.ok) return jsonError(result.error, result.status);

  const response = {
    ...result.value,
    ...(result.warehouseVersion === undefined ? {} : { warehouseVersion: result.warehouseVersion }),
    analyticsState: result.analyticsState,
  } satisfies ListSessionsResponse;
  return jsonResponse(response);
}

export async function getManifest(
  env: Env,
  projectId: string,
  sessionId: string,
): Promise<Response> {
  if (await sessionHasDeletionFence(env, projectId, sessionId)) {
    return jsonError("not_found", 404);
  }

  const object = await env.RECORDINGS.get(manifestKey(projectId, sessionId));
  if (object === null) return jsonError("not_found", 404);

  return new Response(object.body, {
    headers: secureHeaders({
      "content-type": "application/json",
      // Keep browser copies short-lived so a retention delete has a small,
      // documented cache bound as well as removing the R2 object.
      "cache-control": "private, max-age=300, must-revalidate",
    }),
  });
}

export async function getSegment(
  env: Env,
  projectId: string,
  sessionId: string,
  name: string,
): Promise<Response> {
  if (await sessionHasDeletionFence(env, projectId, sessionId)) {
    return jsonError("not_found", 404);
  }

  const object = await env.RECORDINGS.get(`${sessionPrefix(projectId, sessionId)}/${name}`);
  if (object === null) return jsonError("not_found", 404);

  const response = new Response(object.body, {
    headers: secureHeaders({
      "content-type": "application/octet-stream",
      "cache-control": "private, max-age=300, must-revalidate",
      etag: object.httpEtag,
    }),
  });

  return response;
}
