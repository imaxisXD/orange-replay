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

### Visual judging protocol (learned 2026-07-04 — the replay-crop miss)

Judging under flattering conditions hides geometry bugs. The T3.5 replay embed was missing scale-to-fit entirely, but because sessions were recorded in the SAME browser window the dashboard was judged in, recorded width ≈ stage width and the bug presented as "minor letterboxing" instead of the top-left crop every real user would see. Rules:

- **Vary the geometry.** Any surface that renders captured/scaled content (replay viewport, thumbnails, embeds) must be judged with a deliberate mismatch: record at a large viewport, view in a small stage (and vice versa). Same-size testing proves nothing about scaling.
- **DOM assertions ≠ visual correctness.** The e2e proving "the right text exists in the replay iframe" says nothing about whether it's visible. For geometric bug classes, assert bounds (rendered content fits inside its stage) — see `docs/specs/fix-p3b-scale.md`.
- **Don't downgrade symptoms whose cause you haven't identified.** "Top-anchored letterbox, polish later" was a symptom of a missing transform, not a styling nit. A visual oddity goes on the punch list only AFTER its mechanism is understood.

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

### Phase 3 — Dashboard + Player (W3) ✅

- [x] T3.1 dashboard scaffold — `124ea0a`
- [x] T3.1b reskin to finalized design language + judge round — `f10cc9f`, `b23f267`
- [x] T3.2 presence-registry DO, config write endpoints, install-verify — spec `docs/specs/t3.2-presence.md`; verified: lazy-TTL eviction (no alarms), throttled `waitUntil` pings, D1→KV config writes, 401s on all new routes; 194 tests green
- [x] T3.3 `packages/player` — spec `docs/specs/t3.3-player.md`; verified: worker-only decompression, upstream rrweb@2.1.0 (replay-only, no fork imports), 209 tests green. Known nuance: ORS1/live frames don't carry per-batch FLAG_UNCOMPRESSED — decoder tries gzip (magic bytes) then plain JSON; revisit if the wire ever adds per-batch flags.
- [x] T3.4 Live tab — spec `docs/specs/t3.4-live-tab.md`; visually judged vs mock's "Live now" panel with seeded presence sessions (rail treatment, pulse dots, meta lines, mono elapsed, row nav all match); visibility-gated 5s polling; 210 tests green
- [x] T3.5 session detail: player embed — spec `docs/specs/t3.5-detail-player.md`; judged with a REAL session recorded through the demo site + SDK: playback, error markers, amber playhead, sidebar seek, kbd handlers, segments table all verified in-browser; 222 tests green. Verification residuals fixed: T3.2's in-place edit of applied migration 0001 split into `0002_project_config.sql` (migration immutability — runtime column self-heal in project-config.ts stays as belt-and-suspenders; audit in T4.2); happy-dom pragma on replay-timeline tests; runtime `@/` import made relative (root runner can't resolve the alias cross-project — convention: runtime imports in root-tested dashboard libs are relative, `@/` only for type-only/app-only code). Phase-3 judge-loop polish notes: center letterboxed replay vertically; player API gaps (preloaded-manifest injection, teal overlay token, missing .d.ts) noted from T3.5 report.
- [x] T3.6 settings + install pages — spec `docs/specs/t3.6-settings-install.md`; visually judged: config editor with dirty-state save bar (persistence verified through D1 round-trip + reload), real key hash in keys table, install page renders the SDK's actual loader snippet, Live verify showed real "Installed — first event seen" from the registry; backend gaps closed (retentionDays update, GET keys); 230 tests green
- [x] T3.7 full-product Playwright e2e — GATE PASSED (5/5 e2e, 237 unit/integration). Spec `docs/specs/t3.7-product-e2e.md`. The gate earned its keep — found and drove fixes for: (a) test-level stale replay-frame handles + page1/page2 copy after seek; (b) `sdkFlushMs`/`sdkFlushLiveMs` TEST_TIMINGS knob (server-driven 15s cadence vs shortened closeMs); (c) REAL BUG: live follow rendered nothing for mid-session viewers → checkpoint-on-join across DO/SDK/player/dashboard (`docs/specs/fix-live-follow.md`, ARCHITECTURE.md §3 "Live join checkpoint"); (d) REAL BUG: dashboard vite proxy lacked `ws: true` — live WebSockets never reached the worker in dev; (e) REAL BUG: player re-armed rrweb `startLive()` on every live frame, resetting the baseline so all post-snapshot events were silently discarded — baseline now anchored once at the last buffered event. Known v1 semantics: a viewer joining an IDLE session waits for the recorder's next activity (checkpoint rides the ingest ack); the "Connected live" state renders on follow intent, not socket-open (judge-loop polish note).
- [x] Phase 3 judge loop — 5 finder lenses → 10 findings adversarially verified (all CONFIRMED) → FIX-P3 (`docs/specs/fix-p3-judge.md`): player live-buffer/overlay bounds, decode-worker restart, gap-seek, reconnect keyframe re-arm, manifest race, 5 registry-UI violations, viewer-connect wide event, live-proxy request-id, presence seed guard, demo-site "Signal Board" rebrand. Security lens notes (query-string dev token, single-token authz) pinned to T4.2. 240 tests + 5/5 e2e green.
- [x] FIX-P3b replay scale-to-fit — spec `docs/specs/fix-p3b-scale.md`; verified visually with mismatched viewports (whole page scaled 0.56 into the stage, click ripple landing on the recorded button) + geometric e2e assertions green. Verification found two more real bugs: `packages/player` exported `./dist` while every other workspace package exports source — browsers/e2e ran a 3-hour-stale player build (exports now point at src per repo convention; `vp pack` rewrites for publish; if a package change ever seems invisible, check exports→dist staleness FIRST); and the player stamped inline `position:relative` over class-positioned containers by checking inline instead of computed style (collapsed the stage to 0 height → scale math no-op). **Phase 3 COMPLETE.**

### Phase 4 — Packaging, hardening, CI (W4) ✅

- [x] T4.1 self-host packaging — spec `docs/specs/t4.1-selfhost-packaging.md`; mirror script + `--check` verified reproducible, template carries no test vars, guides honest about manual steps/deferred features, README license stays "not yet chosen"; 246 tests green. Note: in-repo template `main` points at `../../apps/worker/src/index.ts` — the published template repo (deferred) will vendor sources; mirror script owns that when publishing lands.
- [x] T4.2 hardening — spec `docs/specs/t4.2-hardening.md`; full audit PASS/FIXED across authz (public surface is now `/api/v1/health` only; `/` returns 404), R2 key validation (incl. sweeper + test routes), input caps (config 64KB, presence string caps), quota-flip verified with no-DO-write test, in-DO append rate limit (429 `rate_limited`, in-memory, TEST_TIMINGS-overridable), nosniff/no-referrer headers, exact-origin CORS, generic 5xx bodies. Live WS now uses 60s HMAC tickets minted over REST — `?token=` rejected (consumer-visible change; player mints per connect/reconnect). Both pinned P3 security notes resolved or documented. 252 tests + 5/5 e2e green (live watch verified under ticket auth). Judge residuals: two stale tests fixed (health probe moved off `/`; raw WS handshake needed Sec-WebSocket-Key/Version for workerd).
- [x] T4.3 observability — spec `docs/specs/t4.3-observability.md`; full coverage table (every route/DO entrypoint/WS handler/queue message/sweep now emits exactly one wide event: `do.live_connect/message/disconnect/error`, `consumer.sweep`, preflight/method-reject/unmatched); version metadata is wired through the logger and Wrangler config (mirror regenerated); identity fields completed; edge→DO→queue→consumer request-id trace asserted in e2e; no stray console; query strings stripped from logged URLs; error fields truncated. 253 tests + 5/5 e2e green. Judge residual: DO debug shape gained firstRequestId — one strict toEqual updated.
- [x] T4.4 CI — spec `docs/specs/t4.4-ci.md`; historical local-first GitHub Actions workflow covered check/test/budgets/e2e/mirror/build with zero secrets. After production moved to Cloudflare Workers Builds and the user chose to avoid duplicate GitHub CI noise, `.github/workflows/ci.yml` was removed. Keep local gates (`vp check`, `vp test`, mirror check, deploy dry-run) as the source of truth before pushing.
- [x] T4.5 final judgment — three full-repo lenses + load exercise, all findings resolved or ledgered:
  - **Conformance**: all 8 core invariants VERIFIED in code (zero-decompression, hibernation-only WS, (tab,seq) idempotency, immutable R2, minimal alarms, sidecar-only metadata, 100KB finalize budget, timestamp-ordered segments). 14 findings triaged → code fixes: manifest served immutable-cacheable (was no-store), deterministic sampling re-check at ingest (shared FNV-1a moved to `@orange-replay/shared/sampling` so honest clients/server can never drift; integration-tested); doc truth-alignment: per-append cost is 2 row writes (~130/session in §7), keepalive-only unload (no sendBeacon — headers), raw-estimate flush trigger, hard-delete retention, 35KB hard bundle ceiling, x-or-tab documented; deferred-list gains explicit entries (edge rate-limiter, orphan-reconcile cron, minimal-sidecar, privacy-tier field, cost tunings).
  - **Privacy**: 5/6 areas PASS; HIGH finding fixed — rrweb Meta events embedded full unscrubbed location.href (query/fragment incl. tokens) in R2 recordings every checkpoint; recorder now scrubs Meta href through scrubUrl(allowUrlParams) at the emit hook (`5d2231b`). DOM-snapshot attrs intentionally untouched (replay fidelity).
  - **Dead code**: removed FLAG_ENCRYPTED, findTransferables block, 4 dead player exports + their orphaned helpers/tests, unused badge.tsx/tabs.tsx (+ dead @radix-ui/react-tabs dep), and the DRIFTED hand-written player .d.ts in the dashboard (stale pre-ticket types shadowing the real source types); coupled SDK/DO idle constants documented.
  - **Load probe** (`scripts/load-probe.mjs`, `d95b73a`): 500 + 2000 appends at ~1.4–1.6k req/s local, p50 6–12ms, p95 11–20ms, 250/250 sessions finalized+indexed end-to-end, zero server_error events.
  - Final state: 255 tests, 5/5 Playwright e2e, vp check clean, mirror --check green. **CAMPAIGN COMPLETE — local-first v1 done; deferred list below is the roadmap.**

- [~] Production Cloudflare deployment — `docs/deployment.md` + `apps/worker/wrangler.jsonc` `env.production`; public commits keep placeholder Cloudflare resource IDs and ignored local env files hold generated production values. Created prod D1, R2, KV, queues, Worker secret, default org/project/write key, and deployed static dashboard assets through the Worker. Production config now uses Wrangler `env.production` and Cloudflare `version_metadata` instead of an `APP_VERSION` var. The production asset build now serves the static `landing/` page at `/`, keeps the dashboard app shell at `/dashboard/index.html`, and routes `/login` plus `/projects/...` through the Worker to that dashboard shell. Secret leak audit passed for current prod token/write-key values in repo files and git history; `scripts/bootstrap-prod-project.mjs` saves generated write keys to the ignored local env file and does not print them. Cloudflare Workers Builds is connected to `imaxisXD/orange-replay` and deploys `main`; GitHub Actions CI is intentionally removed, so Cloudflare's `Workers Builds: orange-replay` check run is the remote deployment signal. Current local verification for the landing wiring: `vp check` passed with the existing 3 rrweb-fork warnings; `vp test` passed 328 tests; `node scripts/mirror-template.mjs --check` passed; `vp run deploy:prod:dry-run` passed and showed the `ASSETS` binding. Re-smoke production root, `/login`, `/or-recorder.js`, health API, authenticated sessions API, and ingest API after the next Cloudflare deploy.

- [x] Cloudflare scale hardening (2026-07-09) — dashboard project config now reaches the SDK through `GET /v1/config` before capture starts (remote sampling, mask/block rules, mask policy, canvas toggle); valid KV hits bypass the unknown-key/IP limiter; config KV values persist while edge reads remain cached for 60 s; project/session binding capacity is sized for the 10K concurrent-session target; SDK ingest retries 429 with `Retry-After`; project presence is deterministically spread across 16 DOs and API reads merge the shards. The hosted Worker split was deliberately not implemented: keep the canonical combined deploy until hosted traffic or independent rollout/failure isolation justifies it.

- [~] Public read-only demo workspace (2026-07-09) — `/api/v1/demo` discovers a dedicated demo project without exposing a private API token; demo auth is allowlisted to session, live, manifest, segment, and live-ticket reads; the dashboard reuses its real sessions, player, and live views under `/demo`; the landing page loads the real SDK with masked recording and clear disclosure. Demo values are stored as Worker secrets and ignored local env values, never in Wrangler vars. `vp check` and all 360 tests pass; Playwright, screenshot comparison, and production smoke checks remain pending.

- [x] Vite+ cache safety (2026-07-11) — replaced workspace-wide `cache: true` with Vite+'s explicit safe split: package scripts are uncached and defined tasks remain cached. This keeps side-effecting `dev`, migration, bootstrap, and deploy scripts from being replayed while preserving task caching. `vp run` loads successfully; two isolated `vp run dev` launches both performed the full startup with `cache disabled`; `vp check` passes with the three existing rrweb-fork warnings; all 500 tests pass.

### Post-v1 product backlog (strategy: `docs/product-moat.md`)

Ranked moat features (each with pain/mechanism/build sketch in the doc): 1) edge injection — zero-code install for CF-proxied zones; 2) everything-buffer + promotion rules (record 100%, 48h, promote what matters); 3) share links / unlimited viewers (scoped session-read tickets + public player route); 4) presence API + co-browse; 5) provable privacy report; 6) ephemeral per-PR replay stacks. Player roadmap in the same doc — **known player gap: multi-tab sessions interleave into one replayer (verified: `mergeReplayEvents` is a timestamp sort, tab identity dropped at decode) — first fix is a tab picker**; then clip export (client-side canvas→WebM), comments, dead-click markers, friction heat-lane.

**AI-era + player-depth specs written and ready to dispatch (2026-07-04):**

- [ ] **F1 — Replay-to-Repro** (`docs/specs/f1-replay-to-repro.md`): any error session → a runnable Playwright regression test + machine-readable failure bundle + markdown report, generated **client-side** (no server inspection — privacy-preserving). New `packages/player/src/repro/` pure module (no rrweb/DOM imports so F2 can reuse it in Node). The differentiated AI move: replay → failing test → hand to a coding agent.
- [ ] **F2 — MCP server** (`docs/specs/f2-mcp-server.md`): `packages/mcp` (`@orange-replay/mcp`), a local stdio MCP bridge exposing 5 tools (list_sessions, get_session_timeline, get_failure_bundle, get_repro_script, list_live_sessions) so the user's own Claude Code/Cursor pulls production replay evidence + F1 repro artifacts. New dep: `@modelcontextprotocol/sdk`. Reuses F1's pure repro module via Node segment decode. **Depends on F1.**
- [ ] **F3 — Player polish** (`docs/specs/f3-player-polish.md`): dead-click detection + hollow-ring markers, louder overlay effects (bigger amber ripples, cursor trail, rage rings), activity heat strip on the scrubber (manifest-only, privacy-clean), journey breadcrumbs, jump-to-first-error. All from existing capture; no SDK/worker changes. Addresses the "effects too subtle / no wow / lacks competitor depth" feedback.
- [ ] **F4 — Analytics dashboard** (`docs/specs/f4-analytics.md`, written 2026-07-10 after a source-checked Clarity gap review): Clarity-class overview in phases — F4.0 metric correctness (replace the broken `url_count` product meaning with covered, per-tab `page_count` + shared `SessionFilter`), F4.1 stats endpoint + overview page on existing D1 data, F4.2 sidecar-only insights reusing the player's existing rage detector through `@orange-replay/shared` (no SDK release), F4.3 SDK capture v2 (visitor ID, referrer/UTM, web vitals, active time, dead clicks, `identify`/`track`), F4.4 users/attribution/performance cards, F4.5 heatmaps, F4.6 smart events + funnels, F4.7 AE trends. Hard rule: every metric opens its exact session set. Overlaps F3 on dead-click definition — whichever lands second reuses the first's definition verbatim.
- Suggested order: **F3 first** (fast, fixes the visible-quality complaint), then **F1**, then **F2** (needs F1). F4 phases can interleave: F4.0+F4.1 are independent of F1–F3 and ship the first visible analytics. Not yet dispatched — awaiting go.

### Deferred (needs real CF account or user decision — do NOT pick these up)

Analytics Engine verification (TRENDS binding declared in Env but not provisioned in wrangler config — no-op today) · Pipelines/Iceberg lake · Vectorize/AI · heatmaps UI backend · console/network lazy capture chunks · processing lane · E2E-encryption tier · privacy-tier config field · BYOC provisioner · hosted-plane auth — decided 2026-07-09: BetterAuth + GitHub/Google OAuth, no email/password (incl. `members` table/org authz; anonymous no-signup workspaces considered and rejected — see ARCHITECTURE §6) · template publishing · orphan-reconcile cron (re-emit finalize for R2 prefixes without D1 rows) · minimal-sidecar mode · compressed-estimate flush trigger + per-append state-write collapse (cost tuning) · **OSS license (user decision pending)**.

## Working protocol (how tasks get executed)

1. Orchestrator writes a precise spec (UI tasks: per-element, derived from `docs/design-language.md`) and saves it to `docs/specs/t<N>-<slug>.md`.
2. Implementation goes to **Codex CLI** (`gpt-5.5`, xhigh — the account config defaults; do NOT pass model flags): detached run, `cd` to repo root inside the wrapper, `--sandbox workspace-write -c sandbox_workspace_write.network_access=true`, done-marker file + stall watch (no log growth ≥ 20 min ⇒ kill and resume). A startup `rmcp … AuthorizationRequired` ERROR line in the log is cosmetic; judge health by log growth.
3. Codex sandboxes cannot run workerd/Playwright — the orchestrator runs the full suite after.
4. Judge loop per phase (PLAN.md §Execution model): finder lenses → dedupe → adversarial verification → fix rounds (max 3).
5. UI is judged visually: boot worker + dashboard, screenshot each screen, compare against `design-final.html`.

## Runbook facts (local dev)

- Gates: `export PATH="$HOME/.vite-plus/bin:$PATH" && vp check && vp test` from repo root.
- Full local dev: `vp run dev` from repo root. It starts the Worker on `8787`, then starts the dashboard on `5200`. Set `CLEAR_DEV_PORTS=1` only when you want the script to stop existing listeners on those ports first. Dev auth uses `apps/worker/.dev.vars` if present, otherwise `.dev.vars.example` (`DEV_API_TOKEN=dev-local-token-0000000000000000`, `DEV_TEST_ROUTES=1`). **`.dev.vars` must NOT exist while running the test suite** (breaks the fails-closed 503 test).
- Worker only: `vp exec --filter @orange-replay/worker -- wrangler dev --port 8787`.
- Dashboard only: `cd apps/dashboard && vp dev --port 5200` (binds IPv6 — use `http://localhost:5200`). Login with the dev token; it is stored under localStorage key `or:token`.
- Seeded demo data: worker `/__test/*` seed routes populate sessions matching the design mock.
- D1 `exec()` splits on newlines — keep multi-line SQL single-line in migrations run through it.
- Design reference server: `python3 -m http.server 5099` at repo root → `http://localhost:5099/design-final.html`.
