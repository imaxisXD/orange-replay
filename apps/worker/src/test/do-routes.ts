import type { Env } from "../env.ts";
import type { AppendArgs, AppendResult } from "../do/contract.ts";
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
    return Response.json(
      await sessionStub(env, body.projectId, body.sessionId).seedBatchesForTest(body),
    );
  }

  if (request.method === "POST" && url.pathname === "/__test/do/flush") {
    const body = (await request.json()) as SessionRequestBody;
    return Response.json(await sessionStub(env, body.projectId, body.sessionId).flushForTest());
  }

  if (request.method === "POST" && url.pathname === "/__test/do/finalize") {
    const body = (await request.json()) as SessionRequestBody;
    await sessionStub(env, body.projectId, body.sessionId).finalizeForTest();
    return Response.json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/__test/do/r2") {
    const key = url.searchParams.get("key");
    if (key === null || !key.startsWith("p/")) {
      return Response.json({ error: "bad_key" }, { status: 400 });
    }

    const object = await env.RECORDINGS.get(key);
    if (object === null) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return new Response(object.body, {
      headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream" },
    });
  }

  if (request.method === "GET" && url.pathname === "/__test/do/debug") {
    const projectId = url.searchParams.get("projectId");
    const sessionId = url.searchParams.get("sessionId");
    if (projectId === null || sessionId === null) {
      return Response.json({ error: "missing_id" }, { status: 400 });
    }

    return Response.json(await sessionStub(env, projectId, sessionId).debug());
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

function sessionStub(env: Env, projectId: string, sessionId: string) {
  return env.SESSION.get(env.SESSION.idFromName(`${projectId}:${sessionId}`));
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}
