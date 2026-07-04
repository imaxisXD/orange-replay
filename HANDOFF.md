# HANDOFF — build status ledger & pickup guide

The living backlog for the Orange Replay build campaign. **Anyone (human, Claude session, Codex run) picking up this repo starts here.** Tick a box only when the task's Definition of Done below is met. Every pending item points at the docs that fully specify it — do not invent scope beyond those pointers.

How this document is used:

- **If the orchestrating session runs out of tokens/context**: hand this file to whoever continues. They work the first unticked item top-to-bottom, following the Working protocol below.
- **Work done by others is provisional**: mark it `[~]` (done, unverified) with the commit hash. The returning orchestrator re-verifies (gates + scope + judge pass) and promotes to `[x]`.
- **Keep it current**: whoever completes or dispatches a task updates this file in the same commit.

## Authority map (read before changing anything)

| Doc                       | Role                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ARCHITECTURE.md`         | Design authority — system behavior, invariants, cost model                                                     |
| `PLAN.md`                 | Execution contract — ground rules, task scopes, logging contract, testing strategy                             |
| `design-final.html`       | **UI visual authority** (static mock, never modify/reformat) — judge all dashboard UI against it by screenshot |
| `docs/design-language.md` | The mock codified: tokens + per-component treatments for implementing UI                                       |
| `docs/specs/`             | Per-task dispatch specs (the exact contract each task was/will be built to)                                    |
| `CLAUDE.md`               | Conventions + toolchain (`vp`) usage                                                                           |

## Definition of Done (every task)

1. `vp check` and `vp test` green from repo root (`export PATH="$HOME/.vite-plus/bin:$PATH"`).
2. Scope respected (only the task's file budget touched; verify with `git status` — never trust an agent's report without checking the disk).
3. For UI tasks: screenshot comparison against `design-final.html` (boot the app, judge each element per `docs/design-language.md`).
4. Wide-event logging contract honored (PLAN.md §Ground rules 5) and cost invariants intact (§4).
5. Commit with a truthful message; tick here in the same commit.

## Status ledger

### Phase 0 — Bootstrap ✅

- [x] Monorepo scaffold, seed router, test harness — `bd45179`, `9a4d957`

### Phase 1 — Spine (W1) ✅

- [x] T1.1 shared wire/types/schemas/logger — `2d9ce77`
- [x] T1.2 SessionRecorder DO — `2a74905`
- [x] T1.3 ingest hot path — `3bb04ca`
- [x] T1.4 queue consumer + sweeper — `6eedeec`
- [x] T1.5 API worker routes — `2f00787`
- [x] T1.6 assembly, migrations, dev vars — `a041079`
- [x] T1.7 cross-module e2e — `bfb5c7e`
- [x] Judge loop (2 rounds, 19 findings fixed) — `cbd0190`, `c4f3d41`

### Phase 2 — Recorder fork + SDK (W2) ✅

- [x] T2.1 vendored rrweb capture fork @2.1.0 — `9e24860`
- [x] T2.2 SDK core — `c3e5ff6`
- [x] T2.3 off-main-thread pipeline — `ff71dea`
- [x] T2.4+T2.5 budgets, demo site, browser e2e — `8610b87`
- [x] Judge loop C1+C2 (privacy hardening, 4-scenario e2e) — `f52b562`, `762fc2d`

### Phase 3 — Dashboard + Player (W3) — IN PROGRESS

- [x] T3.1 dashboard scaffold — `124ea0a`
- [x] T3.1b reskin to finalized design language + judge round — `f10cc9f`, `b23f267`
- [x] T3.2 presence-registry DO, config write endpoints, install-verify — spec `docs/specs/t3.2-presence.md`; verified: lazy-TTL eviction (no alarms), throttled `waitUntil` pings, D1→KV config writes, 401s on all new routes; 194 tests green
- [x] T3.3 `packages/player` — spec `docs/specs/t3.3-player.md`; verified: worker-only decompression, upstream rrweb@2.1.0 (replay-only, no fork imports), 209 tests green. Known nuance: ORS1/live frames don't carry per-batch FLAG_UNCOMPRESSED — decoder tries gzip (magic bytes) then plain JSON; revisit if the wire ever adds per-batch flags.
- [x] T3.4 Live tab — spec `docs/specs/t3.4-live-tab.md`; visually judged vs mock's "Live now" panel with seeded presence sessions (rail treatment, pulse dots, meta lines, mono elapsed, row nav all match); visibility-gated 5s polling; 210 tests green
- [x] T3.5 session detail: player embed — spec `docs/specs/t3.5-detail-player.md`; judged with a REAL session recorded through the demo site + SDK: playback, error markers, amber playhead, sidebar seek, kbd handlers, segments table all verified in-browser; 222 tests green. Verification residuals fixed: T3.2's in-place edit of applied migration 0001 split into `0002_project_config.sql` (migration immutability — runtime column self-heal in project-config.ts stays as belt-and-suspenders; audit in T4.2); happy-dom pragma on replay-timeline tests; runtime `@/` import made relative (root runner can't resolve the alias cross-project — convention: runtime imports in root-tested dashboard libs are relative, `@/` only for type-only/app-only code). Phase-3 judge-loop polish notes: center letterboxed replay vertically; player API gaps (preloaded-manifest injection, teal overlay token, missing .d.ts) noted from T3.5 report.
- [x] T3.6 settings + install pages — spec `docs/specs/t3.6-settings-install.md`; visually judged: config editor with dirty-state save bar (persistence verified through D1 round-trip + reload), real key hash in keys table, install page renders the SDK's actual loader snippet, Live verify showed real "Installed — first event seen" from the registry; backend gaps closed (retentionDays update, GET keys); 230 tests green
- [ ] **T3.7 full-product Playwright e2e** — ← IN FLIGHT (Codex dispatched 2026-07-04; spec: `docs/specs/t3.7-product-e2e.md`). Record→list→playback-with-effects→masking proof→live tab→two-context live watch. Codex writes blind (no Playwright in its sandbox) — I run the suite and drive the fix round.
- [ ] Phase 3 judge loop (extra lens: registry-only UI audit + visual audit vs `design-final.html`)

### Phase 4 — Packaging, hardening, CI (W4) — NOT STARTED

- [ ] T4.1 self-host template mirror + guides + README — PLAN.md row T4.1; ARCHITECTURE.md §6 (tenancy/self-host packaging inversion)
- [ ] T4.2 hardening audit — PLAN.md row T4.2; PLAN.md §Ground rules 7
- [ ] T4.3 observability audit — PLAN.md row T4.3; logging contract PLAN.md §Ground rules 5
- [ ] T4.4 CI (GitHub Actions) — PLAN.md row T4.4
- [ ] T4.5 final judgment (full-repo review vs ARCHITECTURE.md) — PLAN.md row T4.5

### Deferred (needs real CF account or user decision — do NOT pick these up)

Analytics Engine verification · Pipelines/Iceberg lake · Vectorize/AI · heatmaps UI backend · processing lane · E2E-encryption tier · BYOC provisioner · GitHub OAuth · template publishing · deploys · **OSS license (user decision pending)**.

## Working protocol (how tasks get executed)

1. Orchestrator writes a precise spec (UI tasks: per-element, derived from `docs/design-language.md`) and saves it to `docs/specs/t<N>-<slug>.md`.
2. Implementation goes to **Codex CLI** (`gpt-5.5`, xhigh — the account config defaults; do NOT pass model flags): detached run, `cd` to repo root inside the wrapper, `--sandbox workspace-write -c sandbox_workspace_write.network_access=true`, done-marker file + stall watch (no log growth ≥ 20 min ⇒ kill and resume). A startup `rmcp … AuthorizationRequired` ERROR line in the log is cosmetic; judge health by log growth.
3. Codex sandboxes cannot run workerd/Playwright — the orchestrator runs the full suite after.
4. Judge loop per phase (PLAN.md §Execution model): finder lenses → dedupe → adversarial verification → fix rounds (max 3).
5. UI is judged visually: boot worker + dashboard, screenshot each screen, compare against `design-final.html`.

## Runbook facts (local dev)

- Gates: `export PATH="$HOME/.vite-plus/bin:$PATH" && vp check && vp test` from repo root.
- Worker: `cd apps/worker && npx wrangler dev --port 8787`. Dev auth: copy `.dev.vars.example` → `.dev.vars` (`DEV_API_TOKEN=dev-local-token`, `DEV_TEST_ROUTES=1`). **`.dev.vars` must NOT exist while running the test suite** (breaks the fails-closed 503 test).
- Dashboard: `cd apps/dashboard && vp dev --port 5200` (binds IPv6 — use `http://localhost:5200`). Login with the dev token; it is stored under localStorage key `or:token`.
- Seeded demo data: worker `/__test/*` seed routes populate sessions matching the design mock.
- D1 `exec()` splits on newlines — keep multi-line SQL single-line in migrations run through it.
- Design reference server: `python3 -m http.server 5099` at repo root → `http://localhost:5099/design-final.html`.
