import { configKvKey, projectConfigSchema } from "@orange-replay/shared";
import type { ProjectConfig } from "@orange-replay/shared";
import { shardDb } from "../env.ts";
import type { Env } from "../env.ts";
import { sha256Hex } from "../ingest/helpers.ts";
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

  return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
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
