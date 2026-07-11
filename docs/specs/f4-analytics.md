# F4 — Analytics dashboard (Clarity-class insights on the existing two-lane architecture)

## Goal

Orange Replay records sessions but has no analytics surface: no aggregate endpoint, no overview page, and several signals that Clarity treats as table stakes (visitor identity, attribution, web vitals, frustration metrics) are either unaggregated, derivable-but-never-derived, or not captured. This campaign adds a Clarity-class overview dashboard in phases, ordered so each phase ships visible value and later phases never rework earlier ones.

Benchmark: the Microsoft Clarity demo dashboard (KPIs, Users overview, Insights, attribution, device/geo breakdowns, performance, top pages, JS errors). We do not copy it card-for-card; the product direction stays `docs/product-moat.md` ("metric changed → exact sessions → evidence → runnable repro").

**Hard requirement (all phases): every metric is a doorway.** Any number, card, or breakdown row on the dashboard must carry the exact filter parameters that reproduce its session set through `GET /api/v1/projects/:id/sessions`. No aggregate may be shown that cannot open its sessions. This is a review criterion, not a polish item.

## Verified ground truth (source-checked 2026-07-10)

- **`url_count` is broken for "pages per session".** `updateStateWithBatch` increments `urlCount` for every batch carrying a URL, with no comparison to the previous URL (`apps/worker/src/do/session-recorder.ts:1311-1314`). It counts batches, not pages. Must be fixed before the metric ships.
- **A rage-click detector already exists and is tested**: `detectRageClickBursts` (600ms window, 24px radius, ≥3 clicks) in `packages/player/src/rage.ts`, used by the playback overlay. The D1 `rages` column is always 0 only because finalize never runs it. F4.2 reuses this function; nobody writes a new detector.
- **Analytics Engine is not provisioned.** The old optional per-ingest-batch write was removed because no Wrangler environment could execute it. AE is deferred to F4.7 with one datapoint per finalized session. AE is sampled + 3-month retention: trends only, never the source for exact counts or session sets — D1 is.
- **"Active time" cannot be honestly computed from current data.** The player's gap logic (`packages/player/src/timeline.ts:74-89`) sees only sidecar-event spacing — no visibility/foreground signal. The derived metric ships as **"interaction time"** until the SDK captures visible/hidden state (F4.3). Do not label it active time.
- **Internal quick backs are derivable** when both pages run Orange Replay: SPA changes come from `nav` events and full loads carry a new navigation marker plus the batch URL. External destinations without the SDK remain invisible. Ship as “Internal quick backs,” never as universal quick backs.
- **Excessive scrolling is NOT in scope** until we have page-level baselines and better scroll data (scroll is sampled at one event per 2s, `packages/sdk/src/sidecar.ts:162`); Clarity's metric compares against expected page baselines, not raw depth.
- **Dead clicks cannot be detected server-side** — the ingest/finalize path never decompresses rrweb payloads (cost invariant). Playback-time detection is F3 (`docs/specs/f3-player-polish.md`); capture-time detection is F4.3 SDK work.
- Not captured at all today: visitor identity (only a session-scoped cookie exists), referrer/UTM, web vitals (the lone `vital` event is a navigation-start marker from the loader), visible/active time, page lifecycle for MPA.
- Existing queryable base: D1 `sessions` columns `started_at, duration_ms, country, region, city, device, browser, os, entry_url, url_count, clicks, errors, rages, navs, bytes` (`apps/worker/migrations/0001_init.sql:12`); sparse `session_events` (errors + customs with detail); live presence registry. Session-list filters today: country, browser, has_errors, min_duration_ms (`apps/worker/src/api/helpers.ts:147`).

## Phasing

Dispatch order: F4.0 → F4.1 → F4.2 → F4.3 → F4.4; F4.5/F4.6 get their own specs when reached; F4.7 when AE work is scheduled. F4.0–F4.2 require **no SDK release**. Each phase is a separate dispatch with the standard gates (`vp check`, `vp test`, judge loop; UI phases screenshot-judged vs `design-final.html`).

---

## F4.0 — Metric correctness + filter contract (prerequisite, small)

Scope: `apps/worker/src/do/**`, `apps/worker/src/api/**`, `apps/worker/src/consumer/**`, `packages/shared/**`, the next additive migration, and matching guarded test DDL/tests.

1. **Replace the broken product meaning of `urlCount`.** Add nullable `page_count` and integer `analytics_version` fields additively; keep legacy `url_count` readable for compatibility, but never use it for “pages/session.” Existing rows remain `page_count = NULL` and are unknown, not zero. New rows from this phase use `analytics_version = 1`.
   - Track the last scrubbed URL **per tab**, bounded to a sane tab count. One session-level `lastUrl` is incorrect: alternating batches from tabs A and B would look like repeated page changes.
   - Count a full load or same-URL reload from the loader's `vital` event where `d === "navigation"`.
   - Count an SPA transition only when a `nav` event changes the scrubbed URL for that tab. Do not count timer batches or same-URL `replaceState` noise. Use `index.u` only as the current/fallback URL for compatible older batches.
   - Unit-test same-URL batches, same-URL reload, A→B→A, SPA push/pop/replace, and two tabs whose batches alternate.
   - **Historical coverage**: do not use a deploy timestamp as a proxy for trustworthy rows and do not invent a backfill from the inflated column. Stats return `{ includedSessions, totalSessions }`; the dashboard shows `—` when coverage is zero and labels partial coverage.
2. **Date bounds.** Add `from`/`to` (epoch ms, validated) to `buildSessionsQuery` and the sessions route. Keyset pagination semantics unchanged.
3. **Shared filter object.** One zod schema in `packages/shared` — `SessionFilter`: `{ from?, to?, country?, region?, device?, browser?, os?, entry_url_prefix?, has_errors?, min_duration_ms? }` — used by BOTH the sessions list and the F4.1 stats endpoint. Plain query params, no opaque token (saved segments get IDs later, out of scope). Every filter key maps to an indexed/prepared D1 predicate; prepared statements only. Insight filters such as `has_rage` are added with F4.2, when their data becomes trustworthy.

DoD: gates green; sessions endpoint accepts the full filter; page-count fixtures prove the new field and historical coverage; filter parse/encode/query tests agree on canonical values. Aggregate-to-session set equality lands in F4.1 with the stats endpoint.

## F4.1 — Aggregate API + overview dashboard (first visible ship)

Scope: `apps/worker/src/api/**`, `apps/dashboard/**`, migrations (rollup table only if EXPLAIN shows GROUP BY on `sessions` needs it — do not add speculatively).

**API**: `GET /api/v1/projects/:id/stats?<SessionFilter>` (authz middleware as all routes) returning, in one response: session count; avg + p50 duration; total clicks; pages/session (covered `page_count` rows only, see F4.0); breakdowns (top-N + share) by country/region, device, browser, os, entry page; error groups (`session_events` kind=`error` GROUP BY detail, count + affected sessions); live-now count (presence shards). Every number or breakdown row includes the complete typed `SessionFilter` that selects it, not only an undocumented delta. Cache API may cache finalized-session aggregates for 60s per `(project, canonical filter string)`; live-now remains on the existing presence read so the cache cannot make it a minute stale. Wide event per request (route, cache_hit, duration_ms). D1 stays the exact source; verify each query with EXPLAIN QUERY PLAN against the `(project_id, started_at DESC)` index and add covering indexes only where the plan demands.

If seeded query/load evidence requires daily rollups, add only one exact rollup shape that this screen reads. Gate its updates on an atomic per-session `analytics_applied` flag (or equivalent ledger) inside one D1 batch so a queue retry cannot double totals and a failed batch remains retryable. Do not pre-create heatmap, funnel, visitor, or event-rule tables.

**Dashboard**: overview route becomes the project landing tab. Layout per `design-final.html` / `docs/design-language.md`: KPI tile row (Sessions, Avg duration, Pages/session, Live now), breakdown cards (geo, device/browser/OS as tabbed card, entry pages, JS errors), date-range picker (Last 24h / 3d / 7d / 28d) driving the shared filter. **Clicking any tile or row navigates to the sessions list with that exact filter applied** (sessions page must read filters from URL params — add if missing). Registry components only; mono tabular numerals for all figures.

DoD: gates green; screenshot judgment vs mock; set-equality e2e (a breakdown row's count == the row count the sessions list returns for its filter); no metric without a doorway.

## F4.2 — Sidecar-only derived insights (no SDK release)

Scope: `packages/shared/**`, the player rage import/re-export and existing detector tests, `apps/worker/src/do/**`, `apps/worker/src/consumer/**`, migration `000N_insights.sql`, dashboard Insights card.

All derivation uses **sidecar metadata only** (never payloads), inside the existing budgets; pure functions, unit-fixtured. Rage, scroll, and interaction summaries derive at finalize from the complete stored segment event collection **before** the manifest's 10,000-event/256KB timeline cap, otherwise a late-session rage burst or scroll can disappear from the count. Quick-back state is updated on accepted appends because `AppendArgs.tab` is available there and the flattened manifest timeline does not retain tab identity; this uses the existing persisted-state write and adds no timer or extra hot-path write.

1. **Rage clicks**: move the pure detector, types, and constants to `@orange-replay/shared/rage`; the player imports and re-exports that implementation so behavior and existing tests stay identical. The Worker must not depend on `@orange-replay/player` or `rrweb`. Run at finalize over click index events (normalized coords × that click's viewport → px); store one synthetic `rage` timeline event per burst and store **burst count** in the existing `rages` column. Full-event counts remain authoritative. Adjust timeline capping so a small reserved budget keeps notable error/rage/nav markers while ordinary click/scroll events drop first; a late rage must not become filterable but invisible in the manifest timeline. The always-zero column and the dashboard's existing rage badges become real.
2. **`max_scroll_depth`** (0–100 int): max over scroll index events.
3. **`quick_backs`** (int): per-tab internal page sequence A→B→A where dwell on B < 10s (constant, tunable), using the F4.0 page tracker for SPA and recorded full-load transitions. Never combine journeys across tabs and never claim external destinations. Label it “Internal quick backs.”
4. **`interaction_time_ms`**: sum of inter-event gaps, each capped at the player's inactivity-gap threshold (reuse the same constant — one definition across player skip-idle and this metric). UI label: **"Interaction time"**, never "active time".
5. New columns via migration (single-line SQL — D1 `exec()` splits on newlines); queue consumer writes them idempotently; covered sessions finalize with `analytics_version = 2`; stats endpoint gains an `insights` block (rage %, quick-back %, avg interaction time, avg max-scroll) with session-set doorways (`has_rage=1` etc.); dashboard Insights card in the Clarity slot. Older rows stay outside the denominator instead of appearing clean.

DoD: gates green; a seeded session with a scripted rage burst shows rages > 0 end-to-end (SDK fixture → DO → D1 → stats → sessions filter); cost invariants intact (no payload decompression, no new alarms, finalize row-write count unchanged apart from the widened upsert).

## F4.3 — SDK capture v2 (one SDK release)

Scope: `packages/sdk/**`, `packages/shared/**`, ingest/DO/consumer plumbing, migration, e2e. Bundle budget holds: keep the current 32KB gzip target and 35KB hard CI ceiling from `ARCHITECTURE.md`; the loader remains below 2KB. Web-vitals observers use focused `PerformanceObserver` code or a lazy analytics chunk—no new dependency without justification.

1. **Anonymous visitor ID**: first-party cookie `or_v` (UUIDv7, 400-day cap, SameSite=Lax), sent with batches; **no fingerprinting, ever**. D1: `visitor_id` column + `visitors` table `(project_id, visitor_id, first_seen, last_seen, session_count)` maintained by the consumer → unique users, new vs. returning.
2. **Attribution**: at session start capture `document.referrer` **host only** + allowlisted UTM keys (`utm_source`, `utm_medium`, `utm_campaign`) from the entry URL before scrubbing strips them. Columns match those four captured values; do not collect unused UTM fields speculatively.
3. **Web vitals**: LCP, INP, CLS via `PerformanceObserver`, emitted as `vital` index events (the enum slot exists, `packages/shared/src/types.ts:1-9`) with final values flushed on `visibilitychange→hidden`/pagehide. Columns: `lcp_ms`, `inp_ms`, `cls_x1000`. Session value = worst page value.
4. **Real active time + page lifecycle**: visible/hidden tracking (`visibilitychange` + interaction-refreshed heartbeat) → separate `visible_time_ms`, `hidden_time_ms`, and `active_time_ms`; explicit page instance IDs/events for MPA + SPA give per-page dimensions for F4.5/F4.6. When this lands, the dashboard shows real “Active time” where covered and keeps the F4.2 estimate clearly labelled for older sessions. Overall page active time is not enough for an attention heatmap; that later feature needs vertical visible-dwell bins.
5. **Dead clicks at capture**: click followed within 600ms by no rrweb mutation/nav/error (mirror F3's playback definition exactly — one definition, two runtimes) → `dead` index event + `dead_clicks` column. Coordinate with F3 if it lands first.
6. **Public API**: `identify(id, traits?)` (opt-in user identity, scrubbed traits), `track(name, props?)` (alias of existing custom events), `setTag(k, v)`. Documented in the install page snippet. Covered sessions finalize with `analytics_version = 3`; every visitor/attribution/performance card reports version coverage.

DoD: gates green; SDK e2e (Playwright + demo site) asserts visitor cookie persistence across sessions, vitals present in sidecar, active-time sanity (hidden tab accrues none); privacy lens re-run (no PII by default, referrer is host-only, UTM allowlist exact); bundle budget report.

## F4.4 — Users, attribution & performance cards

Dashboard-only consumption of F4.3 data: Users overview card (live/unique/new-vs-returning), Referrer + UTM breakdown card, Performance card (LCP/INP/CLS distributions, good/needs-improvement/poor thresholds per web.dev), JS-errors card upgrade (affected users). Same doorway rule; stats endpoint extended, no new capture.

## F4.5 — Heatmaps (own spec when reached)

Selector-based aggregation as the primary model (we already capture selector + normalized coords + viewport, `packages/sdk/src/scrub.ts`), coordinate bins as fallback; grouped by scrubbed URL + device class + viewport bucket. Click maps and scroll-depth maps first. Attention maps remain out until vertical visible-dwell bins are explicitly captured; F4.3's overall active time does not prove attention by page area. Aggregation tables are added HERE, not before. Rendering rides the existing player/snapshot infrastructure. Every heatmap result links back to its exact contributing sessions through the same `SessionFilter`.

## F4.6 — Smart events + funnels (own spec when reached)

Dashboard-defined rules (URL visited / selector clicked / custom event) evaluated at finalize; funnels = ordered rule sequences over sessions. `track()` (F4.3) is the API leg. Tables land with the feature. D1 first; the Pipelines/Iceberg lake remains deferred per PLAN.md until cross-month analytical volume demands it.

## F4.7 — Analytics Engine trends (when provisioned)

After the Analytics Engine dataset is provisioned, emit **one best-effort datapoint per newly finalized session** from the queue consumer, only after the exact D1 insert succeeds (blobs: country, device, browser, os, entry-page; doubles: 1, duration, errors, rages, bytes). An AE failure never fails ingest, finalization, D1 indexing, billing, or queue acknowledgement. It powers approximate recent sparklines only; every exact number and every doorway stays on D1. Re-check current sampling and retention behavior against official Cloudflare docs during implementation instead of freezing today's limit in code comments.

## Non-goals (this campaign)

Bot traffic reporting (belongs to CDN/edge logs, not SDK signals — revisit with the edge-injection moat feature); excessive-scrolling metric (needs baselines); attention heatmaps without vertical visible-dwell capture; saved segments/watchlist UI (filter params now, IDs later); a generic analytics chatbot (the AI feature stays F1's replay-to-repro direction).

## Constraints & DoD (campaign-wide)

PLAN.md ground rules apply verbatim: cost invariants are correctness (zero payload decompression on ingest/finalize, hibernation eligibility, minimal alarms, idempotent consumer writes), wide-event logging on every new route/unit of work, prepared statements only, authz on every route, registry-only UI judged against `design-final.html`, `vp check` + `vp test` + `vp build apps/dashboard` green per phase. Worker/schema phases also run the real `unstable_dev` integration suite and template-mirror check. Every phase updates HANDOFF.md in the same commit.

Campaign acceptance is end-to-end: for deterministic fixtures, clicking each dashboard metric or breakdown must yield set equality between the aggregate's contributing session IDs and the paginated Sessions result. Duplicate finalize delivery must not change any exact total. Privacy fixtures must prove that raw input text, unapproved URL parameters, referrer secrets, and fingerprint material never reach D1, Queues, Analytics Engine, or logs.
