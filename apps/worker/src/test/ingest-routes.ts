// Test routes for the ingest path — implemented by T1.3.
import type { Env } from "../env.ts";

export function handleIngestTestRoutes(
  _request: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  return Promise.resolve(Response.json({ error: "not_implemented" }, { status: 501 }));
}
