import type { CreatedProjectKeyResponse, ProjectKeyResponse } from "@orange-replay/shared";
import { type Env } from "../env.ts";
import { sha256Hex } from "../ingest/hash.ts";
import {
  createProjectWriteKey,
  listProjectWriteKeys,
  revokeProjectWriteKey,
} from "../project-config/delivery.ts";
import { readStoredProjectConfig } from "../project-config/storage.ts";
import type { SessionAuthContext } from "./auth.ts";
import { jsonError, jsonResponse, readJsonBodyCapped } from "../http.ts";

const KEY_BODY_LIMIT_BYTES = 2 * 1024;
const KEY_NAME_MAX_LENGTH = 64;

export async function getProjectKeys(env: Env, projectId: string) {
  return listProjectWriteKeys(env, projectId);
}

export async function createProjectKey(
  request: Request,
  env: Env,
  projectId: string,
  auth: SessionAuthContext,
): Promise<Response> {
  const body = await readJsonBodyCapped(request, KEY_BODY_LIMIT_BYTES);
  if (!body.ok) return jsonError(body.error, body.status);

  const name = readKeyName(body.value);
  if (name === null) return jsonError("invalid_key_name", 400);

  if (!(await keyManagementRateLimitAllows(env, projectId, auth))) {
    return jsonError("rate_limited", 429);
  }

  const actorId = auth?.hostedSession.user.id ?? null;
  const result = await createProjectWriteKey(env, projectId, name, actorId);
  if (result.status === "not_found") return jsonError("not_found", 404);
  if (result.status === "active_key_limit_reached") {
    return jsonError("active_key_limit_reached", 409);
  }
  if (result.status === "key_history_limit_reached") {
    return jsonError("key_history_limit_reached", 409);
  }
  if (result.status === "key_was_revoked") return jsonError("key_was_revoked", 409);
  if (result.status === "key_cache_unavailable") {
    return jsonError("key_cache_unavailable", 503);
  }

  const response = {
    key: result.key,
    secret: result.secret,
  } satisfies CreatedProjectKeyResponse;
  return jsonResponse(response, {
    headers: { "cache-control": "private, no-store", pragma: "no-cache" },
  });
}

export async function revokeProjectKey(
  env: Env,
  projectId: string,
  keyId: string,
  auth: SessionAuthContext,
): Promise<Response> {
  // Preserve the existing visible order: a missing project is reported before
  // the key-management limiter runs.
  const config = await readStoredProjectConfig(env, projectId);
  if (config === null) return jsonError("not_found", 404);

  if (!(await keyManagementRateLimitAllows(env, projectId, auth))) {
    return jsonError("rate_limited", 429);
  }

  const actorId = auth.hostedSession.user.id;
  const result = await revokeProjectWriteKey(env, projectId, keyId, actorId);
  if (result.status === "key_not_found") return jsonError("key_not_found", 404);
  if (result.status === "key_cache_unavailable") {
    return jsonError("key_cache_unavailable", 503);
  }

  const response = { key: result.key } satisfies ProjectKeyResponse;
  return jsonResponse(response, { headers: { "cache-control": "private, no-store" } });
}

async function keyManagementRateLimitAllows(
  env: Env,
  projectId: string,
  auth: SessionAuthContext,
): Promise<boolean> {
  if (env.KEY_MANAGEMENT_RATE_LIMITER === undefined) return false;
  const actorId = auth.hostedSession.user.id;
  const key = await sha256Hex(`project-key-write:${projectId}:${actorId}`);
  try {
    return (await env.KEY_MANAGEMENT_RATE_LIMITER.limit({ key })).success;
  } catch {
    return false;
  }
}

function readKeyName(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const name = (value as { name?: unknown }).name;
  if (typeof name !== "string" || name.trim() !== name) return null;
  if (name.length < 1 || name.length > KEY_NAME_MAX_LENGTH) return null;
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return null;
  }
  return name;
}
