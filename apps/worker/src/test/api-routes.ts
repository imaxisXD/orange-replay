// Test routes for the dashboard API — implemented by T1.5.
import type { Env } from "../env.ts";

export function handleApiTestRoutes(
  _request: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  return Promise.resolve(Response.json({ error: "not_implemented" }, { status: 501 }));
}
