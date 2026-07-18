# Orange Replay — Domain Glossary

Load-bearing terms in this codebase. Architecture authority: ARCHITECTURE.md.

- **Request plan** — the typed decision `matchDashboardRequest` returns for a dashboard API
  request: its authentication family, the validated path ids its route needs, and the pipeline
  flags (access, limits, mutation origin, response policy). Owned by
  `apps/worker/src/api/dashboard-request-policy.ts`; the matcher is pure and imports no I/O.
- **Route executor** — the work of a granted route, with no ordering responsibilities. The
  registry in `apps/worker/src/api/dashboard-routes.ts` maps plan actions to executors and is
  injectable into `handleApi`, which is the pipeline-test seam.
- **Pipeline** — the fixed dashboard request ordering the handler owns: authenticate → demo
  limit → access (path ids, role matrix, session auth) → analytics limit → mutation origin →
  execute → response policy. Precedence quirks are contract: auth errors before
  `invalid_path_id`, project access before `invalid_segment_name`, public-page rate limit
  before id validation, demo mode gets 401 (not 404) on unknown routes.
