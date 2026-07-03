// Test routes for the SessionRecorder DO — implemented by T1.2.
import type { Env } from "../env.ts";

export function handleDoTestRoutes(
  _request: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  return Promise.resolve(Response.json({ error: "not_implemented" }, { status: 501 }));
}
