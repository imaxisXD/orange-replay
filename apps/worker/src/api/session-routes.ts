import {
  manifestKey,
  sessionPrefix,
  startWideEvent,
  type ListSessionsResponse,
} from "@orange-replay/shared";
import { readFinalizedSessionPage } from "../analytics/finalized-read.ts";
import type { Env } from "../env.ts";
import type { ApiAuthMode } from "./auth.ts";
import { parseSessionListQuery } from "../query/session-query.ts";
import { jsonError, jsonResponse, secureHeaders } from "../http.ts";
import { sessionHasDeletionFence } from "./session-head-routes.ts";
import { replayAssetMapKey } from "../replay-assets/capture.ts";

const DEMO_SESSIONS_LIST_MAX = 50;
const MAX_REPLAY_ASSET_MAP_BYTES = 256 * 1024;

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
    ...(result.analyticsDelivery === undefined
      ? {}
      : { analyticsDelivery: result.analyticsDelivery }),
    ...(result.analyticsView === undefined ? {} : { analyticsView: result.analyticsView }),
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

export async function getReplayAssetMap(
  env: Env,
  projectId: string,
  sessionId: string,
): Promise<Response> {
  if (await sessionHasDeletionFence(env, projectId, sessionId)) {
    return jsonError("not_found", 404);
  }
  const object = await env.RECORDINGS.get(replayAssetMapKey(projectId, sessionId));
  if (object === null || object.size > MAX_REPLAY_ASSET_MAP_BYTES)
    return jsonError("not_found", 404);
  return new Response(object.body, {
    headers: secureHeaders({
      "content-type": "application/json",
      "cache-control": "private, max-age=300, must-revalidate",
    }),
  });
}

export async function getReplayAsset(
  env: Env,
  projectId: string,
  sessionId: string,
  assetHash: string,
): Promise<Response> {
  if (!/^[a-f0-9]{64}$/.test(assetHash)) return jsonError("not_found", 404);
  if (await sessionHasDeletionFence(env, projectId, sessionId)) {
    return jsonError("not_found", 404);
  }
  const row = await env.IDX_00.prepare(
    `SELECT o.r2_key AS r2Key, o.content_type AS contentType, o.bytes
    FROM replay_session_assets s
    JOIN replay_asset_objects o ON o.asset_hash = s.asset_hash
    WHERE s.project_id = ? AND s.session_id = ? AND s.asset_hash = ? AND s.expires_at >= ?
    LIMIT 1`,
  )
    .bind(projectId, sessionId, assetHash, Date.now())
    .first<{ r2Key: string; contentType: string; bytes: number }>();
  if (row === null) return jsonError("not_found", 404);
  const object = await env.RECORDINGS.get(row.r2Key);
  if (object === null || object.size !== row.bytes) return jsonError("not_found", 404);
  return new Response(object.body, {
    headers: secureHeaders({
      "content-type": row.contentType,
      "content-length": String(row.bytes),
      // An authenticated viewer may cache bytes briefly, but retention or a
      // privacy deletion must take effect within the same bound as segments.
      "cache-control": "private, max-age=300, must-revalidate",
      etag: object.httpEtag,
    }),
  });
}
