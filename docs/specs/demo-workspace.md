# Spec: demo-workspace — public live-demo dashboard

Status: implemented 2026-07-09. Production and visual checks remain pending.

## Goal

The landing page records itself with the real SDK into a dedicated **demo project**. The landing "Live demo" buttons open the real dashboard at a public, read-only `/demo` route showing live sessions of real landing-page visitors — including the visitor's own session appearing live. This fills the slot ARCHITECTURE.md §6 already reserved: "a public read-only demo workspace covers try-before-signup instead."

## Non-goals

No user accounts / BetterAuth (still deferred). No new dependencies. No changes to the ingest wire format, SessionRecorder DO, or player internals. No curated/pinned-session mode in v1 (documented fallback if defacement becomes a problem).

## Design

### Env (worker)

- `DEMO_PROJECT_ID?: string` — id of the demo project.
- `DEMO_WRITE_KEY?: string` — plaintext demo write key (write keys are public-by-design; this one is intentionally served to browsers).

Demo behavior is active only when **both** are set and non-empty. When absent, behavior is byte-for-byte today's (fails closed) — covered by tests.

### Public discovery endpoint

`GET /api/v1/demo`

- Demo enabled → `200 {"projectId": "...", "writeKey": "..."}`, `cache-control: public, max-age=60`.
- Demo disabled → generic 404 (same body shape as other unmatched routes).
- No auth. IP rate-limited via `DEMO_API_RATE_LIMITER`. Emits the standard route wide event.

This single endpoint serves both consumers: the landing snippet (key discovery, so no prod key is committed to the repo) and the dashboard `/demo` route (project-id discovery).

### Demo auth context (`apps/worker/src/api/handler.ts`)

In `checkAuth`: if the request has **no** `Authorization` header, demo is enabled, and the route's project param `=== DEMO_PROJECT_ID` → return a demo auth context `{ projects: Set([DEMO_PROJECT_ID]), demo: true }`. A request that _does_ carry a bearer header goes through existing validation unchanged — an invalid bearer must **never** fall back to demo (401, exactly as today).

Route opt-in is **deny-by-default**: only routes explicitly marked demo-readable accept the demo context; every other route treats a demo context as unauthenticated (401). Use an explicit per-route flag/allowlist mechanism, not path-pattern matching.

Demo-readable routes:

| Route                                             | Notes                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /projects/:pid/sessions`                     | clamp `limit` to ≤ 50 when demo (shared constant, e.g. `DEMO_SESSIONS_LIST_MAX`) |
| `GET /projects/:pid/live`                         | presence list                                                                    |
| `GET /projects/:pid/sessions/:sid/manifest`       | already immutable-cached                                                         |
| `GET /projects/:pid/sessions/:sid/segments/:name` | already edge-cached                                                              |
| `POST /projects/:pid/sessions/:sid/live-ticket`   | ticket is already session-scoped, 60s TTL                                        |

NOT demo-readable (must 401 for a demo context): `GET/PUT /config`, `GET /keys` (returns write keys), `GET /install-status`, all `/__test/*` routes, and everything else. The live WS route is unchanged (ticket auth, not bearer).

### Rate limiting

New Workers rate-limiter binding `DEMO_API_RATE_LIMITER` (follow the existing `wrangler.jsonc` binding pattern and the existing missing-binding handling), keyed by `cf-connecting-ip`, 600 req / 60 s. Applied to every demo-context request and to `GET /api/v1/demo`.

### Logging

Per PLAN.md ground rules: exactly one wide event per unit of work via the `@orange-replay/shared` logger, emitted in `finally`; no `console.log`. The existing API event gains an auth-mode field (`authMode: "bearer" | "demo"` — align naming with existing event fields).

### Security invariants (each needs a test)

1. Demo disabled (env unset) → every previously-401 request is still 401; `/api/v1/demo` → 404.
2. A demo context cannot: read or write any other project; `PUT /config` on the demo project; `GET /keys`, `GET /config`, `GET /install-status` on the demo project; hit `/__test/*`.
3. Bearer-authed behavior is unchanged (regression tests stay green); an invalid bearer on a demo-project route → 401, not demo fallback.
4. Sessions-list `limit` is clamped for demo contexts.
5. No client-supplied header/param/body can enable demo for a non-demo project (server derives demo purely from env + project id).

Cost invariants untouched: no timers, no payload decompression, no DO/hibernation changes, no extra `setAlarm()` writes.

## Task A — worker + bootstrap

File budget: `apps/worker/src/api/handler.ts`, `apps/worker/src/index.ts`, `apps/worker/src/app-shell.ts` (serve the dashboard shell at `/demo` and `/demo/*`), the worker `Env` type declaration, `apps/worker/wrangler.jsonc` (dev + `env.production`: vars placeholders + `DEMO_API_RATE_LIMITER`), `apps/worker/.env.example` (local demo values), worker tests, `scripts/bootstrap-demo-project.mjs` (new), `packages/shared/src/constants.ts` (only if a shared constant is genuinely needed).

Bootstrap script: creates the demo org + project (`retention_days: 2`, `sample_rate: 1.0`, `allowed_origins` = the production landing origin per `docs/deployment.md`) + one write key. Follow `scripts/bootstrap-prod-project.mjs` conventions exactly: generated secrets go to the ignored local env file, never printed; print the wrangler commands the operator runs to set `DEMO_PROJECT_ID` / `DEMO_WRITE_KEY`. Header comment: this script touches production — review and test before running.

Tests: the security-invariant list above, `/api/v1/demo` response shape + caching + 404, limit clamp, app-shell served at `/demo`.

## Task B — dashboard demo mode

File budget: `apps/dashboard/src/**` and dashboard tests only.

- `/demo` route tree: fetch `/api/v1/demo` → `projectId`; reuse the existing sessions list, session detail (replay), and live components scoped to that project. 404/network failure → friendly "demo not available" state.
- API client demo mode: derived from the route location (never persisted); requests omit `Authorization`; a 401 in demo mode shows an inline error state and never redirects to `/login`.
- Read-only UI: Settings + Install hidden from nav; persistent slim banner on all demo pages: "Live demo — real sessions from our landing page, read-only." with a primary CTA "Start free" → `/login`. Banner follows `docs/design-language.md` (dark `#0a0a0c`, amber accent, `.lit` treatment where appropriate); it will be judged by screenshot against `design-final.html`.
- Live tab and live session watching must work (ticket mint is demo-readable).
- Reuse existing components/ui primitives (Fluid Functionalism registry components already in the tree); do not hand-roll primitives or duplicate screens.

Tests: `/demo` bypasses the token route guard; api client omits the auth header in demo mode; nav items hidden; demo-unavailable state renders.

## Task C — landing instrumentation

File budget: `landing/index.html` only. Keep edits surgical and avoid a wholesale reformat.

- Both "Live demo" anchors (currently `href="/login"`) → `/demo`.
- Recording snippet before `</body>`: a small inline async IIFE that fetches `/api/v1/demo` (same origin); on 200 it boots the genuine SDK loader (reproduce the real snippet shape from `packages/sdk/src/loader.ts` / the dashboard install page) with the returned `writeKey`, same-origin recorder bundle (`/or-recorder.js`) and ingest. Non-blocking; silently no-ops on 404, network error, or `file://` preview; the failure path must never throw or log.
- Add `data-orange-block` to any input/form elements on the page.
- Disclosure: one short line adjacent to the mid-page Live demo CTA: "This page records anonymized, masked sessions to power the live demo — your visit may show up there." Match surrounding typography; understated. (External-facing copy — gets human review before ship.)

## Verification

Run `vp check` and `vp test` from the repo root. The test config sets `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`, so the developer's local `apps/worker/.env` stays in place but cannot change test behavior. Then run the full Playwright suite, compare `/demo` and the landing page with `design-final.html`, and record the result in `HANDOFF.md`.
