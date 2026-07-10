# Orange Replay — Build Plan (v1, local-first)

Operating document for the orchestrated build. ARCHITECTURE.md is the design authority; this file is the execution contract. Claude (main session) orchestrates, merges, reviews, and is the final judge. Implementation is done by **Codex sub-agents (gpt-5.5-codex, reasoning effort xhigh)** via the codex-companion shared runtime, each scoped to a small feature set, never the whole system.

## Decisions locked with the user (2026-07-03)

- **Pacing**: autonomous run-through of all phases; report at the end (task list tracks progress).
- **Cloudflare**: local-only (wrangler dev / miniflare / vitest-pool-workers). No real resources, no deploys.
- **Dashboard auth**: dev bearer token for v1. Hosted-plane auth decided 2026-07-09: **BetterAuth + GitHub/Google OAuth**, no email/password (ARCHITECTURE §6); implementation deferred to hosted launch.
- **rrweb**: fork immediately — vendored in-repo at a pinned upstream tag, capture-side only.
- **Toolchain**: Vite Plus (`vp` 0.2.2) — `vp install` / `vp check` / `vp test` / `vp build`. Oxlint + Oxfmt, Vitest.
- **UI**: React + Tailwind + shadcn with the **Fluid Functionalism registry** (`npx shadcn@latest add @fluid/<component>`). Never hand-roll a component the registry provides. Hard review criterion.
- **Logging**: wide events (canonical log lines) — one structured JSON event per unit of work per service. Contract below.
- **Not chosen yet (user decision, flagged)**: OSS license.

## Deferred (out of v1 scope — most need a real CF account)

Analytics Engine verification, Pipelines → Iceberg lake, Vectorize/AI features, heatmaps UI, the opt-in processing lane, E2E encryption tier, BYOC provisioner Workflow, hosted auth (BetterAuth + GitHub/Google OAuth), template-repo publishing, any deploy.

## Ground rules (every agent, every task)

1. **Read first**: ARCHITECTURE.md + this file + the task's interface contract. Do not re-architect; raise conflicts in the final report instead.
2. **Quality gates**: `vp check` and `vp test` must pass before returning. Paste the final output in the report.
3. **Scope discipline**: touch only the files in the task's file budget. New dependencies must be declared in the report with a one-line justification.
4. **Cost invariants are correctness** (from ARCHITECTURE.md): DO hibernation eligibility (hibernation WebSockets only; no timers outliving a request; alarms via storage), minimal `setAlarm()` writes, idempotency by `(session, tab, seq)`, ingest path never inflates payloads, sidecar scrubbing on by default, immutable R2 objects, KV read-through on miss.
5. **Logging contract** (wide events, `packages/shared` logger only):
   - One event per unit of work: HTTP request (ingest/API), DO RPC, DO alarm, queue message, cron run.
   - Emit in `finally`; JSON via `console.log`; levels `info`/`error` only; never unstructured strings; no scattered mid-flow logs.
   - Base fields: `ts, service, event, request_id, outcome (success|client_error|server_error|dropped), status_code?, duration_ms, version`.
   - Identity fields when known: `project_id, org_id, session_id, tab, seq`.
   - Service-specific business fields, e.g. ingest: `bytes_in, flags, live, quota_state, kv_hit`; DO: `buffered_bytes, batch_count, segment_n, flush_reason, viewer_count, alarm_kind`; consumer: `attempts, rows_written, dlq`; API: `route, cache_hit`.
   - `request_id` (UUIDv7) minted at ingest/API edge, propagated via `x-or-request-id` into DO RPCs and queue messages.
6. **Testing** (decided in Phase 0 — `@cloudflare/vitest-pool-workers` is incompatible with Vite Plus' vitest 4, "runner not supported"): pure decision logic lives in plain functions unit-tested under `vp test`; worker behavior is integration-tested via `unstable_dev` booting the real worker (see `apps/worker/tests/harness.test.ts` for the canonical pattern) against guarded `/__test/*` routes enabled by `DEV_TEST_ROUTES=1`. tsconfig split: `src/` is workers-typed, `tests/` is node-typed (`tests/tsconfig.json`) — never mix the two type worlds in one config. SDK tested with happy-dom + Playwright e2e against `wrangler dev`.
7. **Security**: authz on every API route (dev token for now), R2 key validation (no traversal), prepared statements only, size caps enforced, CORS exact.

## Execution model

- Each phase = one Workflow; each task = one Codex agent in an **isolated git worktree**; Claude merges in dependency order and resolves conflicts.
- Contract-first sequencing: `packages/shared` lands before parallel fan-out; agents code against its exported types.
- Every task prompt carries: scope, file budget, interface contract, acceptance criteria, ground rules.
- **Judge loop** (Claude, per phase): re-run gates → adversarial review workflow (lenses: architecture invariants, correctness, security, logging contract, UI-registry compliance, simplification) → verified findings become fix tasks sent back to Codex agents → re-verify. Max 3 loops; residuals fixed directly by Claude and noted.

## Phase 0 — Bootstrap (Claude inline, no Codex)

Git init + initial commit (worktrees need HEAD) · Vite Plus monorepo scaffold (`apps/worker`, `apps/dashboard`, `packages/shared`, `packages/rrweb-fork`, `packages/sdk`, `packages/player`, `fixtures/demo-site`) · root configs (tsconfig, oxlint/oxfmt, .gitignore) · `vp install` + `vp check` green on empty skeleton · Codex runtime smoke task (no-op read-only) confirming model gpt-5.5 + xhigh plumbing.

**Gate**: `vp check` passes; smoke agent returns.

## Phase 1 — Spine (Workflow W1)

Phase 0 seeded `apps/worker` with the **final router** (`src/index.ts`), `env.ts` (bindings + `shardDb`), `wrangler.jsonc`, and the `/__test/*` dispatch (`src/test/harness-routes.ts`) — these are seed-owned and final. Each fan-out task owns exactly its module directory plus its own test-route file (`src/test/do-routes.ts` → T1.2, `ingest-routes.ts` → T1.3, `consumer-routes.ts` → T1.4, `api-routes.ts` → T1.5), so parallel worktrees never touch a shared file. T1.6 therefore shrinks to: D1 migrations SQL, local seed script, `.env` template, replacing the `FinalizeMessage` placeholder in `env.ts` with the shared import, and any integration glue the merge reveals.

| Task | Scope                                                                                                                                                                                      | Depends       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| T1.1 | `packages/shared`: wire codec (ingest body `[index][0x00][payload]`), ORS1 segment codec, types, constants, zod schemas, wide-event logger, unit tests                                     | — (gate task) |
| T1.2 | `SessionRecorder` DO: (tab,seq) dedupe, SQLite buffering, ORS1 flush → R2, alarm lifecycle (minimal writes), finalize → queue + manifest, hibernation WS hub, live-flag return             | T1.1          |
| T1.3 | Ingest handler: CORS, header/size validation, KV config + D1 read-through, quota drop, `request.cf` enrichment, gzip-normalize fallback, DO RPC, wide event                                | T1.1          |
| T1.4 | Queue consumer (idempotent D1 upserts + usage rollups, per-message ack/retry, DLQ classification) + retention sweeper cron                                                                 | T1.1          |
| T1.5 | API Worker routes: health, dev-token auth middleware, sessions list (filters), manifest fetch, segment stream (+Cache API), live WS proxy to DO                                            | T1.1          |
| T1.6 | `apps/worker` assembly: router, wrangler.jsonc (DO migration `new_sqlite_classes`, R2/KV/D1/Queues bindings, cron), D1 migration SQL, local seed script (org/project/key), `.env` template | T1.2–T1.5     |
| T1.7 | Integration e2e: node script drives synthetic wire batches at `wrangler dev` → asserts local R2 segments/manifest, D1 rows after shortened idle, segment fetch via API, live WS echo       | T1.6          |

**Gate**: T1.7 green end-to-end locally. Then judge loop.

## Phase 2 — Recorder fork + SDK (Workflow W2)

| Task | Scope                                                                                                                                                                                                                                                                                                                                                                                                                              | Depends   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| T2.1 | `packages/rrweb-fork`: vendor rrweb capture side at pinned tag (record + snapshot + types; no replay/player code), tsdown build, LICENSE/NOTICE preserved, UPSTREAM.md (tag, sync procedure)                                                                                                                                                                                                                                       | —         |
| T2.2 | `packages/sdk` core: <2 KB loader (pre-buffer errors/clicks), session mgmt (UUIDv7, sessionStorage+cookie, tab id, 30-min idle rotation), remote config fetch, masking defaults (`data-orange-block`, mask-all-inputs)                                                                                                                                                                                                             | T2.1      |
| T2.3 | SDK worker pipeline: postMessage transferables → Web Worker gzip (`CompressionStream`, uncompressed-fallback flag), adaptive batching (15 s / live 3–5 s from ingest ack, 128 KB, visibility/pagehide), transport (keepalive/beacon, backoff, tiered drop: mousemove → scroll → never mutations), sidecar builder with scrubbing (query-strip URLs, truncate errors, click selector + normalized coords, scroll depth, web vitals) | T2.2      |
| T2.4 | Tests + budgets: unit (happy-dom), wire-conformance against `packages/shared` fixtures, bundle-size budget in CI config (core ≤ 20 KB gz, loader ≤ 2 KB)                                                                                                                                                                                                                                                                           | T2.3      |
| T2.5 | e2e: `fixtures/demo-site` + Playwright — real browser records demo interactions → local worker → assert stored session decodes (node-side gunzip) with expected clicks/scrolls in sidecar                                                                                                                                                                                                                                          | T2.4 + W1 |

**Gate**: T2.5 green. Judge loop (extra lenses: main-thread cost, privacy defaults, bundle size).

## Phase 3 — Dashboard + Player (Workflow W3)

| Task | Scope                                                                                                                                                                                                                                               | Depends        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| T3.1 | `apps/dashboard` scaffold: Vite React TS, Tailwind, shadcn init + `@fluid` registry, app shell/nav, dev-token login, typed API client, dev proxy to worker                                                                                          | —              |
| T3.2 | Worker additions: presence-registry DO (start/heartbeat/finalize pings, TTL), project-config write endpoints, install-verify endpoint ("first event seen")                                                                                          | W1             |
| T3.3 | `packages/player`: manifest loader → instant timeline, ORS1 slicing, decode Web Worker (`DecompressionStream`), rrweb replayer wrapper (cursor trail, click ripples, rage-click burst), skip-inactivity, speed, seek-by-segment, live follow via WS | W1             |
| T3.4 | Sessions list page: filter bar, table (registry components), live-now tab from presence registry                                                                                                                                                    | T3.1 + T3.2    |
| T3.5 | Session detail: player embed, timeline event sidebar (jump-to-click/error), metadata header                                                                                                                                                         | T3.1 + T3.3    |
| T3.6 | Settings + install pages: masking rules editor, capture toggles, sampling/retention, keys, snippet with copy + live verify                                                                                                                          | T3.1 + T3.2    |
| T3.7 | e2e: Playwright — record demo session → appears in list → plays with cursor/click effects (assert replayer DOM) → live tab shows active session → two-context live watch                                                                            | T3.4–T3.6 + W2 |

**Gate**: T3.7 green — the visible-product milestone. Judge loop (extra lens: registry-only UI audit).

## Phase 4 — Packaging, hardening, CI (Workflow W4)

| Task | Scope                                                                                                                                                    | Depends   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| T4.1 | Self-host packaging: template mirror script → `infra/template` (single-worker deploy layout), self-host guide, SDK install doc, root README              | W1–W3     |
| T4.2 | Hardening: authz audit on every route, R2 key validation audit, rate-limit + quota-flip path, security headers, input caps                               | W1–W3     |
| T4.3 | Observability audit: wide-event coverage per unit of work, no stray console.log, `observability.enabled`, request-id propagation test                    | W1–W3     |
| T4.4 | CI: GitHub Actions — `vp check`, `vp test`, builds, bundle budgets, Playwright e2e (local worker), template-mirror dry run                               | T4.1–T4.3 |
| T4.5 | Final judgment (Claude): full-repo review (security + code-review + ARCHITECTURE.md conformance checklist), scaled-down local load script vs doc targets | all       |

**Gate**: T4.5 clean. Final report to user with everything found/fixed and the deferred list.

## Risk register

- `vp` + `@cloudflare/vitest-pool-workers` compatibility → fallback `unstable_dev`; record choice.
- `vp create` may be interactive → hand-scaffold to Vite Plus conventions, validate with `vp check`.
- rrweb fork size/build complexity → capture-side only; replay side uses upstream npm in the player (not customer-page code).
- Miniflare gaps (AE, exact DO billing semantics) → assert _code_ invariants in review (hibernation eligibility is statically checkable: no `accept()`, no stray timers), runtime billing verification deferred to real-account phase.
- Codex agents drifting on conventions → every prompt embeds ground rules; judge loop enforces.
