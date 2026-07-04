// Dev-only test surface, reachable only when env.DEV_TEST_ROUTES === "1"
// (never set in production config). The dispatch table below is FINAL (seed-
// owned); each W1 task implements its own sub-route module:
//   /__test/do/*       -> T1.2 (do-routes.ts)
//   /__test/ingest/*   -> T1.3 (ingest-routes.ts)
//   /__test/consumer/* -> T1.4 (consumer-routes.ts)
//   /__test/api/*      -> T1.5 (api-routes.ts)
import { manifestKey } from "@orange-replay/shared";
import type { Env } from "../env.ts";
import { handleApiTestRoutes } from "./api-routes.ts";
import { handleConsumerTestRoutes } from "./consumer-routes.ts";
import { handleDoTestRoutes } from "./do-routes.ts";
import { handleIngestTestRoutes } from "./ingest-routes.ts";

export async function handleTestRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/__test/harness") return harnessCheck(env);
  if (path.startsWith("/__test/do/")) return handleDoTestRoutes(request, env, ctx);
  if (path.startsWith("/__test/ingest/")) return handleIngestTestRoutes(request, env, ctx);
  if (path.startsWith("/__test/consumer/")) return handleConsumerTestRoutes(request, env, ctx);
  if (path.startsWith("/__test/api/")) return handleApiTestRoutes(request, env, ctx);
  return Response.json({ error: "not_found" }, { status: 404 });
}

/** Exercises every binding once so integration tests can assert the local stack works. */
async function harnessCheck(env: Env): Promise<Response> {
  const stub = env.SESSION.get(env.SESSION.idFromName("harness:smoke"));
  const pong = await stub.ping();

  const presence = env.PRESENCE.get(env.PRESENCE.idFromName("harness"));
  const presenceStatus = await presence.fetch("https://presence.internal/install-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "harness" }),
  });

  const key = manifestKey("harness_project", "harness_session");
  await env.RECORDINGS.put(key, new Uint8Array([1, 2, 3]));
  const obj = await env.RECORDINGS.get(key);
  const r2 = obj !== null && (await obj.arrayBuffer()).byteLength === 3;

  await env.CONFIG.put("harness", "ok");
  const kv = (await env.CONFIG.get("harness")) === "ok";

  const row = await env.IDX_00.prepare("SELECT 1 AS one").first<{ one: number }>();

  return Response.json({
    do: pong,
    presence: presenceStatus.ok,
    r2,
    kv,
    d1: row?.one ?? null,
  });
}
