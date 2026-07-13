import { isValidPathId, parseRecordingObjectKey } from "../api/helpers.ts";
import type { Env } from "../env.ts";
import type { AppendArgs, AppendResult } from "../do/contract.ts";
import {
  listProjectPresence,
  readProjectInstallStatus,
  readProjectPresenceDebug,
  sendPresenceSessionRequest,
} from "../do/presence-client.ts";
import type { TestSeedBatchesArgs } from "../do/session-recorder.ts";

interface TestAppendBody extends Omit<AppendArgs, "payload" | "receivedAt"> {
  payloadB64: string;
  receivedAt?: number;
}

interface SessionRequestBody {
  projectId: string;
  sessionId: string;
}

export async function handleDoTestRoutes(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/__test/do/append") {
    const body = (await request.json()) as TestAppendBody;
    if (!hasValidSessionIds(body)) {
      return Response.json({ error: "invalid_id" }, { status: 400 });
    }
    const stub = sessionStub(env, body.projectId, body.sessionId);
    const result: AppendResult = await stub.appendBatch({
      ...body,
      payload: decodeBase64(body.payloadB64),
      receivedAt: body.receivedAt ?? Date.now(),
    });

    return Response.json(result);
  }

  if (request.method === "POST" && url.pathname === "/__test/do/seed-batches") {
    const body = (await request.json()) as TestSeedBatchesArgs;
    if (!hasValidSessionIds(body)) {
      return Response.json({ error: "invalid_id" }, { status: 400 });
    }
    return Response.json(
      await sessionStub(env, body.projectId, body.sessionId).seedBatchesForTest(body),
    );
  }

  if (request.method === "POST" && url.pathname === "/__test/do/flush") {
    const body = (await request.json()) as SessionRequestBody;
    if (!hasValidSessionIds(body)) {
      return Response.json({ error: "invalid_id" }, { status: 400 });
    }
    return Response.json(await sessionStub(env, body.projectId, body.sessionId).flushForTest());
  }

  if (request.method === "POST" && url.pathname === "/__test/do/finalize") {
    const body = (await request.json()) as SessionRequestBody;
    if (!hasValidSessionIds(body)) {
      return Response.json({ error: "invalid_id" }, { status: 400 });
    }
    await sessionStub(env, body.projectId, body.sessionId).finalizeForTest();
    return Response.json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/__test/do/r2") {
    const rawKey = url.searchParams.get("key");
    const analyticsMatch =
      rawKey === null ? null : /^p\/([^/]+)\/([^/]+)\/analytics\.ndjson$/.exec(rawKey);
    const key =
      analyticsMatch?.[1] !== undefined &&
      analyticsMatch[2] !== undefined &&
      isValidPathId(analyticsMatch[1]) &&
      isValidPathId(analyticsMatch[2])
        ? { ok: true as const, key: analyticsMatch[0] }
        : rawKey === null
          ? { ok: false as const }
          : parseRecordingObjectKey(rawKey);
    if (!key.ok) {
      return Response.json({ error: "bad_key" }, { status: 400 });
    }

    const object = await env.RECORDINGS.get(key.key);
    if (object === null) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return new Response(object.body, {
      headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream" },
    });
  }

  if (request.method === "GET" && url.pathname === "/__test/do/debug") {
    const ids = readSessionIds(
      url.searchParams.get("projectId"),
      url.searchParams.get("sessionId"),
    );
    if (!ids.ok) {
      return Response.json({ error: "missing_id" }, { status: 400 });
    }

    return Response.json(await sessionStub(env, ids.projectId, ids.sessionId).debug());
  }

  if (request.method === "GET" && url.pathname === "/__test/do/live") {
    const ids = readSessionIds(
      url.searchParams.get("projectId"),
      url.searchParams.get("sessionId"),
    );
    if (!ids.ok) {
      return Response.json({ error: "missing_id" }, { status: 400 });
    }

    return sessionStub(env, ids.projectId, ids.sessionId).fetch(request);
  }

  if (request.method === "POST" && url.pathname.startsWith("/__test/do/presence/")) {
    return callPresenceTestRoute(request, env, url.pathname);
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

function sessionStub(env: Env, projectId: string, sessionId: string) {
  return env.SESSION.get(env.SESSION.idFromName(`${projectId}:${sessionId}`));
}

async function callPresenceTestRoute(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  if (typeof body.projectId !== "string" || !isValidPathId(body.projectId)) {
    return Response.json({ error: "projectId is required" }, { status: 400 });
  }

  const route = pathname.slice("/__test/do/presence".length);
  if (!["/ping", "/remove", "/list", "/install-status", "/debug"].includes(route)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const requestId = "test-presence-request";
  if (route === "/ping" || route === "/remove") {
    if (typeof body.sessionId !== "string" || !isValidPathId(body.sessionId)) {
      return Response.json({ error: "sessionId is required" }, { status: 400 });
    }
    await sendPresenceSessionRequest(env, route, requestId, {
      ...body,
      projectId: body.projectId,
      sessionId: body.sessionId,
    });
    return Response.json({ ok: true });
  }

  if (route === "/list") {
    const now = typeof body.now === "number" ? body.now : Date.now();
    const result = await listProjectPresence(env, body.projectId, requestId, now);
    return result === null
      ? Response.json({ error: "presence unavailable" }, { status: 503 })
      : Response.json(result);
  }

  if (route === "/install-status") {
    const result = await readProjectInstallStatus(env, body.projectId, requestId);
    return result === null
      ? Response.json({ error: "presence unavailable" }, { status: 503 })
      : Response.json(result);
  }

  const result = await readProjectPresenceDebug(env, body.projectId, requestId);
  return result === null
    ? Response.json({ error: "presence unavailable" }, { status: 503 })
    : Response.json(result);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function hasValidSessionIds(body: { projectId?: unknown; sessionId?: unknown }): boolean {
  return (
    typeof body.projectId === "string" &&
    typeof body.sessionId === "string" &&
    isValidPathId(body.projectId) &&
    isValidPathId(body.sessionId)
  );
}

function readSessionIds(
  projectId: string | null,
  sessionId: string | null,
): { ok: true; projectId: string; sessionId: string } | { ok: false } {
  const ok =
    projectId !== null &&
    sessionId !== null &&
    isValidPathId(projectId) &&
    isValidPathId(sessionId);
  return ok ? { ok: true, projectId, sessionId } : { ok: false };
}
