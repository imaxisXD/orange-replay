# Orange Replay — Domain Glossary

Load-bearing terms in this codebase. Architecture authority: ARCHITECTURE.md.

- **Request plan** — the typed decision `matchDashboardRequest` returns for a dashboard API
  request: its authentication family, the validated path ids its route needs, and the pipeline
  flags (access, limits, mutation origin, response policy). Owned by
  `apps/worker/src/api/dashboard-request-policy.ts`; the matcher is pure and imports no I/O.
- **Route executor** — the work of a granted route, with no ordering responsibilities. The
  registry in `apps/worker/src/api/dashboard-routes.ts` maps plan actions to executors and is
  injectable into `handleApi`, which is the pipeline-test seam.
- **Latest accepted export** — the one logical warehouse row per (project_id, export_id):
  accepted producer retries create physical duplicates, and the copy with the highest
  export_sequence (ties broken by recorded_at) wins. Stated once as a SQL fragment in
  `apps/worker/src/analytics/latest-exports.ts`; the read queries, the watermark visibility
  proof, and both deletion backends all rank rows through it. Scoping differs on purpose:
  session/event reads pin `export_sequence <=` the warehouse version, deletion fencing never
  does (an old doorway snapshot must not resurrect erased sessions).
- **Session lifecycle** — the one answer to "is this session closed":
  empty | open | finalizing | finalized, owned by `apps/worker/src/do/session-lifecycle.ts`.
  A session closes the moment `finalizingAt` persists (append gates and live joins fail
  closed while manifest/queue work is in flight) and stays closed once only the tombstone
  remains; the tombstone wins over any lingering state. `beginFinalizing` is the single
  idempotent transition. The append gate, alarm, live hub, and the ack's `closed` flag all
  consume this module; the SDK reacts to `ack.closed` and never re-derives the state.
- **Pipeline** — the fixed dashboard request ordering the handler owns: authenticate → demo
  limit → access (path ids, role matrix, session auth) → analytics limit → mutation origin →
  execute → response policy. Precedence quirks are contract: auth errors before
  `invalid_path_id`, project access before `invalid_segment_name`, public-page rate limit
  before id validation, demo mode gets 401 (not 404) on unknown routes.
