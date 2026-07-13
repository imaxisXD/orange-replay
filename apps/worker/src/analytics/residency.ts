import {
  analyticsExportEnabled,
  analyticsReadBackend,
  shardDb,
  type AnalyticsReadBackend,
  type Env,
} from "../env.ts";

export type ProjectAnalyticsState = "d1_rollback" | "d1_residency" | "compare" | "fresh";

export type ProjectAnalyticsReadMode =
  | { ok: true; backend: AnalyticsReadBackend; state: ProjectAnalyticsState }
  | { ok: false; error: "analytics_configuration_invalid"; status: 503 };

export function jurisdictionAllowsDefaultAnalytics(jurisdiction: unknown): boolean {
  return jurisdiction === null;
}

export async function projectAnalyticsReadMode(
  env: Env,
  projectId: string,
): Promise<ProjectAnalyticsReadMode> {
  const configured = analyticsReadBackend(env);
  if (configured === "d1") return { ok: true, backend: "d1", state: "d1_rollback" };

  const row = await shardDb(env, 0)
    .prepare("SELECT jurisdiction FROM projects WHERE id = ? LIMIT 1")
    .bind(projectId)
    .first<{ jurisdiction: string | null }>();

  // Missing or non-default residency state fails closed to the compatibility
  // backend. The default Data Catalog cannot currently honor EU or FedRAMP.
  if (row === null || !jurisdictionAllowsDefaultAnalytics(row.jurisdiction)) {
    return { ok: true, backend: "d1", state: "d1_residency" };
  }
  if (!analyticsExportEnabled(env) || env.ANALYTICS_STREAM === undefined) {
    return { ok: false, error: "analytics_configuration_invalid", status: 503 };
  }
  return {
    ok: true,
    backend: configured,
    state: configured === "compare" ? "compare" : "fresh",
  };
}
