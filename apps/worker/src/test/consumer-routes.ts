// Test routes for the queue consumer + sweeper — implemented by T1.4.
import type { Env } from "../env.ts";

export function handleConsumerTestRoutes(
  _request: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  return Promise.resolve(Response.json({ error: "not_implemented" }, { status: 501 }));
}
