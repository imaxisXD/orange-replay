// Ingest hot path — implemented by T1.3 (see PLAN.md). This module owns
// src/ingest/** and src/test/ingest-routes.ts, nothing else.
import type { Env } from "../env.ts";

export function handleIngest(
  _request: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  return Promise.resolve(Response.json({ error: "not_implemented" }, { status: 501 }));
}
