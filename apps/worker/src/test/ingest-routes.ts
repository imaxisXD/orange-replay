import { configKvKey, projectConfigSchema } from "@orange-replay/shared";
import type { ProjectConfig } from "@orange-replay/shared";
import { shardDb } from "../env.ts";
import type { Env } from "../env.ts";
import { sha256Hex } from "../ingest/helpers.ts";
import { projectConfigDeliveryTestHooks } from "../project-config/delivery.ts";
import { createTestDatabaseSchema } from "./database-schema.ts";

interface SeedRequest {
  key: unknown;
  config: unknown;
  kv?: unknown;
}

export function handleIngestTestRoutes(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/__test/ingest/seed" && request.method === "POST") {
    return seedIngestControlPlane(request, env);
  }
  if (url.pathname === "/__test/ingest/config-cache" && request.method === "GET") {
    return readConfigCache(url, env);
  }
  if (url.pathname === "/__test/ingest/key-state" && request.method === "GET") {
    return readKeyState(url, env);
  }
  if (url.pathname === "/__test/ingest/mark-key-cache-pending" && request.method === "POST") {
    return markKeyCachePending(url, env);
  }
  if (
    url.pathname === "/__test/ingest/mark-active-key-cache-pending" &&
    request.method === "POST"
  ) {
    return markActiveKeyCachePending(url, env);
  }
  if (url.pathname === "/__test/ingest/repair-active-key-cache" && request.method === "POST") {
    return repairActiveKeyCache(url, env);
  }
  if (url.pathname === "/__test/ingest/start-key-cache-write" && request.method === "POST") {
    return startKeyCacheWrite(url, env);
  }
  if (url.pathname === "/__test/ingest/finish-key-cache-write" && request.method === "POST") {
    return finishKeyCacheWrite(url, env);
  }

  return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
}

async function readKeyState(url: URL, env: Env): Promise<Response> {
  const keyHash = readKeyHash(url);
  if (keyHash instanceof Response) return keyHash;
  const row = await shardDb(env, 0)
    .prepare(
      `SELECT
        active,
        cache_synced AS cacheSynced,
        cache_final_check_at AS cacheFinalCheckAt,
        (SELECT COUNT(*) FROM key_cache_writes w WHERE w.key_hash = keys.key_hash)
          AS cacheWriteCount
      FROM keys
      WHERE key_hash = ?`,
    )
    .bind(keyHash)
    .first<{
      active: number;
      cacheSynced: number;
      cacheFinalCheckAt: number | null;
      cacheWriteCount: number;
    }>();
  return Response.json({ state: row });
}

async function markKeyCachePending(url: URL, env: Env): Promise<Response> {
  const keyHash = readKeyHash(url);
  if (keyHash instanceof Response) return keyHash;
  const now = Date.now();
  const finalCheckAt =
    url.searchParams.get("finalCheck") === "due"
      ? 0
      : projectConfigDeliveryTestHooks.keyCacheFinalCheckTime(now);
  const result = await shardDb(env, 0)
    .prepare(
      `UPDATE keys
      SET active = 0, revoked_at = ?, cache_synced = 0, cache_final_check_at = ?
      WHERE key_hash = ?`,
    )
    .bind(now, finalCheckAt, keyHash)
    .run();
  return Response.json({ changed: result.meta.changes ?? 0 });
}

async function markActiveKeyCachePending(url: URL, env: Env): Promise<Response> {
  const keyHash = readKeyHash(url);
  if (keyHash instanceof Response) return keyHash;
  const now = Date.now();
  const finalCheckAt =
    url.searchParams.get("finalCheck") === "due"
      ? 0
      : projectConfigDeliveryTestHooks.keyCacheFinalCheckTime(now);
  const results = await shardDb(env, 0).batch([
    shardDb(env, 0)
      .prepare(
        `UPDATE projects
        SET sample_rate = 0.5, config_version = config_version + 1
        WHERE id = (SELECT project_id FROM keys WHERE key_hash = ?)`,
      )
      .bind(keyHash),
    shardDb(env, 0)
      .prepare(
        `UPDATE keys
        SET cache_synced = 0, cache_final_check_at = ?
        WHERE key_hash = ? AND active = 1`,
      )
      .bind(finalCheckAt, keyHash),
  ]);
  return Response.json({ changed: results[1]?.meta.changes ?? 0 });
}

async function repairActiveKeyCache(url: URL, env: Env): Promise<Response> {
  const now =
    url.searchParams.get("advanceFinalCheck") === "1" ? Date.now() + 16 * 60 * 1_000 : Date.now();
  const repaired = await projectConfigDeliveryTestHooks.repairActiveProjectKeyCache(env, now);
  return Response.json({ repaired });
}

async function startKeyCacheWrite(url: URL, env: Env): Promise<Response> {
  const keyHash = readKeyHash(url);
  if (keyHash instanceof Response) return keyHash;
  const writeId = await projectConfigDeliveryTestHooks.beginActiveKeyCacheWrite(
    shardDb(env, 0),
    keyHash,
  );
  if (writeId === null) return Response.json({ error: "key_not_active" }, { status: 409 });
  return Response.json({ writeId });
}

async function finishKeyCacheWrite(url: URL, env: Env): Promise<Response> {
  const writeId = url.searchParams.get("writeId");
  if (writeId === null || !/^cache_write_[a-f0-9-]{36}$/.test(writeId)) {
    return Response.json({ error: "writeId is not valid" }, { status: 400 });
  }
  await projectConfigDeliveryTestHooks.finishActiveKeyCacheWrite(shardDb(env, 0), writeId);
  return Response.json({ ok: true });
}

function readKeyHash(url: URL): string | Response {
  const keyHash = url.searchParams.get("keyHash");
  if (keyHash === null || !/^[a-f0-9]{64}$/.test(keyHash)) {
    return Response.json({ error: "keyHash must be a SHA-256 hash" }, { status: 400 });
  }
  return keyHash;
}

async function readConfigCache(url: URL, env: Env): Promise<Response> {
  const keyHash = url.searchParams.get("keyHash");
  if (keyHash === null || keyHash.length === 0) {
    return Response.json({ error: "keyHash is required" }, { status: 400 });
  }

  const config = await env.CONFIG.get(configKvKey(keyHash), { type: "json" });
  return Response.json({ config });
}

async function seedIngestControlPlane(request: Request, env: Env): Promise<Response> {
  let body: SeedRequest;
  try {
    body = (await request.json()) as SeedRequest;
  } catch {
    return Response.json({ error: "request body must be JSON" }, { status: 400 });
  }

  if (typeof body.key !== "string" || body.key.length === 0) {
    return Response.json({ error: "key is required" }, { status: 400 });
  }

  const parsedConfig = projectConfigSchema.safeParse(body.config);
  if (!parsedConfig.success) {
    return Response.json({ error: "config is not valid" }, { status: 400 });
  }

  const config = parsedConfig.data;
  const keyHash = await sha256Hex(body.key);
  await createTestDatabaseSchema(shardDb(env, 0));
  await putRows(env, keyHash, config);

  if (body.kv === true) {
    await env.CONFIG.put(configKvKey(keyHash), JSON.stringify(config));
  }

  return Response.json({ keyHash });
}

async function putRows(env: Env, keyHash: string, config: ProjectConfig): Promise<void> {
  const db = shardDb(env, 0);
  const now = Date.now();

  await db
    .prepare(`INSERT OR REPLACE INTO orgs (id, name, shard, created_at) VALUES (?, ?, ?, ?)`)
    .bind(config.orgId, config.orgId, config.shard, now)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO projects (id, org_id, name, jurisdiction, retention_days, sample_rate, allowed_origins, mask_policy_version, mask_rules, capture_toggles, quota_state, config_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      config.projectId,
      config.orgId,
      config.projectId,
      config.jurisdiction ?? null,
      config.retentionDays,
      config.sampleRate,
      JSON.stringify(config.allowedOrigins),
      config.maskPolicyVersion,
      JSON.stringify(config.maskRules ?? []),
      JSON.stringify(
        config.capture ?? {
          heatmaps: false,
          console: false,
          network: false,
          canvas: false,
        },
      ),
      config.quotaState,
      config.version ?? 1,
      now,
    )
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO keys (key_hash, project_id, active, created_at) VALUES (?, ?, ?, ?)`,
    )
    .bind(keyHash, config.projectId, config.active ? 1 : 0, now)
    .run();
}
