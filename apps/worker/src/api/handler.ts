// Dashboard API — implemented by T1.5 (see PLAN.md). This module owns
// src/api/** and src/test/api-routes.ts, nothing else.
import type { Env } from "../env.ts";

export function handleApi(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
  return Promise.resolve(Response.json({ error: "not_implemented" }, { status: 501 }));
}
