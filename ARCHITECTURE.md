# Orange Replay — Architecture

Session replay built natively on Cloudflare. Design goals, in priority order:

1. **Cheap at scale** — replay is a storage+egress business; R2's zero egress and per-session Durable Objects make the unit economics structurally better than ClickHouse/S3-based competitors.
2. **Self-hostable on the user's own Cloudflare account** (BYOC) with near-zero ops — no Kubernetes, no ClickHouse, no Kafka (unlike PostHog/OpenReplay/Highlight self-host).
3. **Fast SDK** — main-thread cost is the product's reputation; everything heavy happens off-thread and compressed bytes are never inflated on the server.
4. **Production posture from day one** — idempotent ingest, ordered events, tenant isolation, data residency, retention enforcement, abuse controls.

---

## 1. System overview

```
                                   ┌────────────────────────── control plane ─────────────────────────┐
 Browser SDK ──POST /v1/ingest──▶ Ingest Worker ──RPC──▶ Session DO ──flush──▶ R2 (segments+manifest)
   (rrweb fork,                    │ auth: KV key cache      │ order/buffer      │ lifecycle: IA → delete
    WebWorker gzip)                │ enrich: request.cf      │ live WS broadcast │
                                   │ rate limit binding      │ idle alarm ───────┼──▶ Queue: session.finalized
                                                                                 │        │
 Dashboard/Player ◀──authenticated streamed segments (short browser cache)────┘        ▼
   (Workers Static Assets)                                                  Consumer Worker (batched)
   ▲                                                                          ├─▶ D1: control + billing + export outbox
   └── API Worker ── R2 SQL (finalized analytics/list) ◀─ Data Catalog        ├─▶ Pipelines: scrubbed analytics rows
                     ├─ session heads (presence + bounded D1 handoff rows)     └─▶ Webhooks / integrations
                     ├─ D1 (direct recording lookup + live control)
                     └─ Vectorize (semantic session search, phase 2)
```

One repo. **The canonical deployable is a single combined Worker** (`apps/worker`); the hosted plane splits it into per-role Workers via thin entry shims only when scale demands isolation:

| Deployable        | Role                                                                                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/worker`     | **Canonical build.** Ingest routes + dashboard API + `SessionRecorder` DO + queue consumer + retention cron in one Worker (direct imports, no service bindings). This is what self-host deploys and what dev/CI runs.                                                       |
| `apps/hosted-*`   | Hosted-plane split (`hosted-ingest`, `hosted-api`, `hosted-consumer`): thin entry shims over the same packages, deployed separately so the hot path is isolated from dashboard deploys with its own limits/observability. Added when hosted scale requires it — not before. |
| `packages/sdk`    | Browser recorder (`@orange-replay/sdk`).                                                                                                                                                                                                                                    |
| `packages/player` | Playback component (rrweb-player wrapper + our segment loader).                                                                                                                                                                                                             |
| `packages/shared` | Wire format, schemas (zod), event types, constants — the contract everything compiles against.                                                                                                                                                                              |
| `infra/`          | D1 migrations tooling, Terraform for hosted plane, Deploy-to-Cloudflare template mirror.                                                                                                                                                                                    |

Inverting the packaging (combined first, split later) means the self-host artifact can never drift: it _is_ the product. All real logic lives in packages; an "app" is only an entry point plus a wrangler config.

---

## 2. SDK (the part users judge us on)

### Loading

- **Loader snippet < 2 KB** inline: starts a pre-buffer (captures `error`, `unhandledrejection`, early clicks, nav timing), then async-loads the recorder bundle. No blocking script.
- **Recorder core: 32 KB gzip target, 35 KB hard CI ceiling** (measured ~33 KB with the full rrweb 2.1.0 record path — lighter than rrweb-based competitors' 40–60 KB; the original 20 KB target resumes as a roadmap item via fork-side stripping of iframe/shadow-DOM/legacy paths), zero runtime dependencies. Canvas capture is opt-in through project config. Console/network capture remain planned lazy plugin chunks and are not collected yet.

### Recording

- rrweb-based capture (fork, pinned): full DOM snapshot + incremental mutations, input masking **on by default** (`mask-all-inputs`, text masking by selector, `data-orange-block` to fully block subtrees). Canvas and cross-origin iframe capture opt-in only.
- **Why a fork** (pinned, tracking upstream — the same play as PostHog's and Sentry's rrweb forks): (1) supply-chain and release control over code that executes on _customers'_ pages — nothing lands unreviewed; (2) a capture-only build — strip the player, packers, and pako paths to hit the ≤20 KB budget; (3) the emit path is rewired to `postMessage` transferables for the worker-thread pipeline, which upstream's in-thread callback design doesn't accommodate; (4) default-deny masking baked into the build rather than configured around it. Generally useful fixes flow back upstream.
- **Privacy is default-deny**: nothing leaves the page unmasked unless the integrator explicitly allows it. This is a selling point, not a config burden. Masking happens **at capture, in the browser** — same as FullStory/PostHog/Hotjar (`data-orange-block` ≈ their suppress/exclude classes) — so the "server never sees it" property costs nothing here; we're strictly stricter because masking is the default, not opt-in.
- **Config-driven capture (dashboard-controlled)**: before rrweb starts, the SDK fetches `GET /v1/config` with the public write key. The Worker serves the D1-backed project config through persistent KV with a 30 s edge cache. Sampling, masking/block rules, policy version, and canvas capture apply on that page load with no customer deploy. The SDK keeps local sampling as a ceiling and ignores invalid remote CSS selectors. A timeout, server error, or malformed config fails closed to no recording; only an explicit 404 from an older Worker falls back to local settings for upgrade compatibility. Console/network toggles are stored for the planned lazy capture chunks but do not claim to collect data today. Masking rule sets are versioned (`maskPolicyVersion`) for auditability.

### Off-main-thread pipeline (the perf differentiator)

1. rrweb emits events on the main thread (unavoidable) → immediately `postMessage` to a **Web Worker** (transferable where possible).
2. Worker serializes, delta/strips redundant fields, and compresses with **native `CompressionStream('gzip')`** — no JS zlib on the main thread, no pako in the bundle.
3. Batches flush on: **adaptive timer**, ~128 KB raw-estimate (the timer dominates typical sessions; switching the byte trigger to the compressed estimate is a known tuning opportunity), visibility change, or `pagehide`. Default cadence 15 s; the ingest response carries a `live` flag when viewers are watching this session and the SDK tightens to 3–5 s. Flush count is the main per-session cost driver (DO requests + SQLite rows written scale with it), so we only pay for real-time cadence when someone is actually watching — competitors flush every ~5 s for everyone.
4. Transport: `fetch(..., { keepalive: true })` for unload-time batches (< 64 KB keepalive limit — final batches are kept small), regular `fetch` otherwise. (`sendBeacon` is deliberately NOT used: it cannot carry the `x-or-*` auth/session headers ingest requires.) Network errors, 5xx, and 429 responses retry up to five times with exponential backoff; `Retry-After` is honored. On sustained failure, cap memory and drop lowest-value events first (mousemove → scroll → mutations never).
5. Fallback for browsers without `CompressionStream`: send uncompressed with a header flag; the ingest Worker compresses before storage so the stored format is uniform.

### Wire protocol (`POST /v1/ingest`)

- Headers: `x-or-key` (project write key), `x-or-session`, `x-or-tab` (per-tab id — part of the idempotency key), `x-or-seq` (monotonic per-tab batch counter), `x-or-flags`.
- Body: `[ index-json ][ 0x00 ][ gzip payload ]` — a **tiny uncompressed index sidecar** followed by the opaque compressed rrweb batch. The sidecar schema is **deliberately generous from day one** — clicks (selector + normalized x/y + viewport size), scroll depth, masked-input focus/blur, navigations, errors, web vitals, custom events, batch time range — because every field captured cheaply now is a future feature (heatmaps, funnels, detectors) that ships with history already in the lake, no SDK update or backfill needed.
- **Sidecar fields are scrubbed at capture by default**: URLs lose query strings and fragments (path kept, specific params allowlistable), error messages truncated, custom payloads capped. The sidecar flows to stores without jurisdiction controls (D1/Queues/AE/Pipelines), so capture-time scrubbing is what keeps the residency story airtight. A **minimal-sidecar mode** (event kinds + timestamps only) is PLANNED for strict-compliance projects (not yet built) — coarser search, absolute residency.
- **The server never decompresses the payload.** The sidecar gives the backend everything it needs for search/indexing/live-timeline; the gzip bytes pass through DO → R2 untouched and are only inflated in the viewer's browser via `DecompressionStream`. This is a large CPU/cost win competitors don't have.
- `x-or-flags` is a bitfield: bit 0 = uncompressed fallback, **bit 1 = E2E-encrypted (reserved from v1)**, customer key id in the sidecar (`enc.k`). Because the server never reads payloads anyway, the E2E tier is a pure SDK+player feature later — reserving the bit and key-id field now means no wire-format migration when it ships.

### Session semantics

- `sessionId` = UUIDv7 stored in `sessionStorage` + a sliding first-party cookie; survives SPA navigation and multi-tab (tab id in batch metadata). The cookie refreshes on the SDK's existing throttled touch write, not on every event. Browser rotation and server close share the same `>= 30 minutes idle` boundary. Before an idle tab rotates, it checks the still-valid shared cookie and rejoins that active session instead of overwriting it with a new id. A server `closed` response always wins and forces the next batch onto a fresh id; one session-change coordinator serializes both cases. This timeout is the session-identity boundary and crash fallback, not a product-visibility delay: a recording appears after its first accepted batch and keeps the same id while final details complete in the background.
- Deterministic **sampling decided client-side after the config request and before capture starts**, so unsampled sessions send no replay batches. Server re-checks to prevent abuse.
- `orangeReplay.getSessionUrl()` — returns the replay deep-link for attaching to Sentry/Datadog/console logs.

---

## 3. Ingest path

### Ingest Worker (stateless, hot)

1. **Auth**: write key → project config via **persistent KV** (cached at edge with `cacheTtl: 30`, ~ms). Config carries origin allowlist, sampling rate, quota state, masking rules/policy version, and capture toggles. **On KV miss, read through to the control plane (D1) before rejecting.** The ingest request never writes that result back to KV because a delayed request could overwrite a newer revocation. Key creation, revocation, project settings, and bootstrap tools are the only config writers. Their D1 rows keep pending and final-check markers, and every active KV writer has a short-lived D1 job. Failed, terminated, or overlapping KV work therefore remains visible to the repair loop; steady valid traffic still stays on KV while a missing entry safely falls back to D1.
2. **Abuse/rate control**: valid KV hits skip the IP-based unknown-key lookup limiter, so a large office/NAT cannot throttle its normal batches. KV misses and unknown keys use the lookup limiter (300/min/location/IP). Known traffic uses a 60,000 batches/min/location project-key limit plus a 12,000 new-sessions/min/location project limit, sized above the 10K-concurrent-session target at the normal 15 s cadence. The per-session in-DO append limiter, server sampling re-check, quota checks, origin checks, and hard compressed-body cap remain the final boundaries. Cloudflare's rate-limit counters are intentionally approximate and location-local, so billing/quota correctness never depends on them.
3. **Enrichment**: attach `request.cf` (country, city, ASN, bot score if available, TLS) — geo/device data for free, no client lookup, no IP stored by default (GDPR posture).
4. **Route**: `env.SESSION.idFromName(`${projectId}:${sessionId}`)` → RPC `appendBatch(...)`. Per-session DO = natural sharding; a session produces ~0.2 req/s, nowhere near the ~1K req/s per-DO limit. No hot keys.

### `SessionRecorder` Durable Object (one per active session)

SQLite-backed DO. Responsibilities:

- **Ordering & idempotency**: batches keyed by **(tab, seq)** in SQLite — seq counters are per-tab and multiple tabs share one session id, so the tab id must be part of the idempotency key; duplicate (tab, seq) = no-op (SDK and queue retries are safe). Segments order batches by timestamp, not seq (seq isn't globally monotonic across tabs); the player orders by event timestamps anyway. Clock skew: server receive time for session bounds, batch-internal timestamps for playback timing.
- **Buffering**: append compressed batch rows (each ≤ 1 MB, well under the 2 MB value limit). Each append costs two billed SQLite row writes — the batch insert plus the session-state upsert (durability for dedupe counters); collapsing the state write is a known optimization — fewer, larger batches are strictly cheaper, which is what the SDK's adaptive cadence delivers. At **≥ 1 MB buffered or 30 s**, flush a **segment** to R2 and delete flushed rows (stay far from the 10 GB DO cap; steady-state DO storage is ~1 segment).
- **Live mode**: viewers connect via WebSocket (**hibernation API only — `ctx.acceptWebSocket()`, never `accept()`**) to the same DO; incoming batches are broadcast as-is — live session watching is nearly free because the DO is already awake. The hello frame includes a sidecar-only counter/timeline snapshot plus already-flushed immutable segment references. Immediately after hello, the DO sends every still-pending stored batch in `(t0, tab, seq)` order. The browser loads and inflates both sources; the server still never decompresses replay data. Attachments (`serializeAttachment`) carry viewer identity across hibernation. `appendBatch` returns `viewerCount > 0`, which the ingest Worker relays to the SDK as the `live` flag (adaptive flush cadence).
- **Live join checkpoint**: the player chooses the newest usable full-snapshot checkpoint from the hello segments, then applies pending and later WebSocket frames once by `(tab, seq)`. If no stored checkpoint exists, the DO still requests one: the next ingest ack carries `checkpoint: true`, and the SDK responds with `takeFullSnapshot()`. When presence becomes idle, the player refreshes that stored history, waits for the segment and pending-tail decode, and changes the same player from follow mode to review mode. Play and seek then work across the received history. If recording activity returns, the same player reconnects and follows again. This is not finalization and does not emit a fake terminal event. It makes a reload during the idle-to-finalized window playable from bytes already received, without a timer or another alarm.
- **Finalization**: one alarm, queue-pattern for both deadlines (idle 2 min for flush-tail, 30 min for session close). **Don't reset the alarm on every append** — each `setAlarm()` is a billed SQLite row write; keep the next-fire time in memory and only re-arm when it drifts past the deadline or after a cold start (`getAlarm()` on construct). On close, persist `finalizingAt` first so later appends and live joins fail closed; flush the remainder; write `manifest.json` to R2; send attached viewers that immutable manifest; mark presence `finalizing`; write the analytics sidecar; emit `session.finalized` to the Queue; then do one final socket sweep and let the DO evict. Playback handoff therefore does not wait for analytics or queue work. The consumer removes presence only after the D1 session, billing, and export-outbox transaction commits, and retries instead of acknowledging if that removal fails.
- **Async interleaving**: SQLite ops are synchronous (`ctx.storage.sql`) so append is race-free without `blockConcurrencyWhile` on the hot path. Finalization also never holds `blockConcurrencyWhile` across R2, Queue, or Presence calls; the persisted `finalizingAt` gate supplies the closed-session invariant while those calls are in flight.
- **Hibernation eligibility is a billing invariant**: DO duration is billed only while actively running or while pinned in memory _unable_ to hibernate — hibernation-eligible idle time is free. So: hibernation WebSockets only, no `setTimeout`/`setInterval` outliving a request (alarms instead), no long-polling. Break this and a 10-minute session bills ~75 GB-s of duration instead of ~1–2 s of active CPU time — a ~50× cost difference on the single biggest line item.

### `PresenceRegistry` Durable Objects (16 per active project)

Session presence is split deterministically by session id across 16 DO names (`project:presence:0..15`). A heartbeat or lifecycle update touches exactly one shard; list and install-status reads fan out in parallel and merge the results. A heartbeat newer than 60 seconds means `live`; an older open row becomes `idle` instead of being deleted. Finalization marks the same row `finalizing`, and the successful queue consumer removes it. Reads prune abandoned, non-finalizing rows lazily after the close deadline plus a grace period, so this DO stays alarm-free. A finalizing row is not pruned on that short timer: it remains until confirmed D1 cleanup, with the recording's retention expiry as a hard fallback (legacy rows are capped at 365 days). At the 10K-session target the sharding changes the worst case from one project-wide DO receiving roughly 500 heartbeat writes/s to about 31 writes/s per shard, without adding a global coordinator. A shard outage never blocks recording because the session DO remains the recording source of truth. A failed shard makes the separate `session-heads` read fail instead of returning a partial list; the dashboard keeps its cached rows and tries again on the next poll.

### Segment format (zero-server-decompression, reliable playback)

`DecompressionStream('gzip')` in some browsers stops at the first gzip member, so we don't rely on naive member concatenation. A segment is:

```
[ magic "ORS1" ][ u32 batchCount ][ u32 offsets[]... ][ gzip batch 0 ][ gzip batch 1 ]...
```

The DO writes this by concatenating stored compressed batches with a header — still never inflates anything. The player slices by offsets and decompresses each batch independently (also enables parallel decode + coarse seeking).

`manifest.json` per session: segment list (key, byte size, time range, batch count), the merged **index sidecar timeline** (clicks, errors, navs, rage-click detections, custom events with timestamps) — this powers the player's activity bar, skip-inactivity, and jump-to-error _without downloading any segment_.

### R2 layout & lifecycle

```
p/{projectId}/{sessionId}/manifest.json
p/{projectId}/{sessionId}/seg-000001.ors
```

- Segments and manifests are **immutable in R2** (the manifest is written once at finalize). Active playback reads already-flushed segments from R2 and pending batches from the session DO. Authenticated delivery uses a short private browser cache instead of a shared immutable edge cache, so a retention or privacy deletion has a clear five-minute cache bound.
- Retention: age-based R2 lifecycle to Infrequent Access at 30 d; per-project retention is enforced by a **retention sweeper** (cron Worker → D1 query for expired sessions → recording R2 batch delete ≤ 1000 keys + D1 deletion state). Finalized analytics uses a published deletion record for immediate logical removal, followed by an Iceberg transaction, compaction, and snapshot expiry within 24 hours. Catalog-owned R2 objects are never deleted directly. Don't rely on lifecycle rules for per-tenant policy.

---

## 4. Index, search, analytics

- **D1, fixed shard set, for operational truth.** D1 bindings are static (declared in Wrangler config), so the hosted plane runs a planned `IDX_00…IDX_15` shard set and assigns an org to a shard. Self-host is one org and one D1. D1 owns accounts, projects, keys, membership, billing rollups, exact recording ID → manifest lookup, retention state, and the analytics export ledger. The finalized session summary remains there as a compact control row for playback and rollback, but dashboard aggregates and full filtered/sorted finalized-session scans do not run on D1. The Queue consumer writes the session, its first-commit `indexed_at` time, exact billing change, sparse event compatibility rows, and export outbox in one idempotent D1 batch.
- **D1 for money; R2 SQL for analytics.** `session.finalized` carries exact byte/segment counts, so the queue consumer updates D1 monthly usage only when it inserts the session for the first time. Analytics Engine may later provide approximate, short-lived sparklines, but it is never a billing or doorway source.
- **Continuous session list, exact analytics.** `/sessions` remains the complete exact R2 SQL list used by filters, metric doorways, pinned warehouse versions, and pagination. A separate private no-store `session-heads` feed is only an operational overlay for unpinned `newest` and `duration` views. It merges open presence rows with a bounded set of D1 point candidates: session exports above the caller's verified watermark, sessions starting after the exact list's frozen upper time, rows whose first D1 commit happened after this view opened, and at most 100 session ids carried forward from the previous head poll. If no warehouse watermark is available, such as a fresh load during an R2 SQL outage, the overlay reads only the latest 100 D1 commits through the same project/index-time index so export-disabled sessions do not disappear. Each source uses a purpose-built index, candidate ids are capped before metadata filtering, and D1 never executes the page's arbitrary full-project sort. The dashboard keeps returning an already-seen id until the exact `/sessions` page contains it; a deletion fence removes it. Merge order is exact R2, then exact D1, then provisional presence, and the R2 cursor never changes. Pinned metric doorways, clicks/pages/friction sorts, and exact-only filters do not merge heads. Provisional wire rows keep stable numeric placeholders for compatibility, but `details_state=provisional` is the validity contract and the UI hides final-only values rather than presenting those placeholders as facts.
- **Phase 2 — semantic search**: at finalize, Workers AI generates a session summary ("user tried checkout 3×, card form errored twice, rage-clicked submit") + embedding → **Vectorize**. Query: "show me sessions where users struggled with checkout." No competitor's self-host tier has this.
- **Opt-in processing lane** (per-project, off by default, dashboard toggle): segments are just gzip in R2, so features that need recording _content_ — full-text session search, dead-click/form-abandonment detectors, post-hoc selector redaction — run as an async consumer that inflates segments **at rest**, writes derived data to D1/the lake, and discards the inflated bytes (Workflows drives historical backfills, so a newly shipped detector applies to already-stored sessions too). The ingest path never inflates anything regardless of toggles; the lane is off contractually on Strict-tier projects and cryptographically impossible on E2E ones. **Heatmaps notably don't need this lane** — clicks/scroll-depth with normalized coordinates are already in the sidecar, so heatmaps are pure aggregations over the lake rendered as overlays at view time.
- **Pipelines → Iceberg → R2 SQL for finalized analytics.** The ingest path never writes the warehouse. Finalization first commits a stable, scrubbed export job to a D1 outbox in the same transaction as the session and billing row. A scheduled exporter retries those jobs into one structured Pipeline stream, which fans out into `analytics_sessions`, `analytics_events`, and `analytics_deletions` Data Catalog tables. Pipelines adds `__ingest_ts` and day partitioning, so physical erasure uses a partition-aware Iceberg writer plus snapshot expiry, not DuckDB or direct object deletion. Reads dedupe stable export IDs because a producer crash can resend an accepted record. A D1 watermark advances only after R2 SQL proves that every distinct export ID through that sequence is visible; stats and their linked recording list use that same `warehouse_version`. Pipeline or R2 SQL failure never loses replay data, never changes billing, and never becomes a fake zero dashboard. Hosted production returns cached-stale data or a clear analytics error instead of silently falling back to D1. The self-host template keeps the warehouse optional until the operator provisions the paid/beta services. Exact contract and rollback: `docs/specs/f4-r2-analytics-cutover.md`.
- **Queues, not Workflows, on the per-session path.** The async plane is one cheap fan-out step per session at very high volume — exactly Queues' shape (batches of 100, 5K msg/s, ~$0.0000012/session). Workflows buys durable _multi-step_ execution (retries per step, sleeping for days), which the per-session path doesn't need and shouldn't pay for at millions of instances. Workflows earns its keep in the control plane instead: the **BYOC provisioner/upgrader** (deploy → verify → migrate → roll back, per customer account) is a textbook Workflow. The inverse also holds — **Queues can't replace the session DO**: no partition keys, no per-key state or timers, 128 KB message cap, and at 3 ops/message a queue hop costs ~8× a DO RPC. The DO assembles the session; the Queue delivers the fact that it finished.

---

## 5. Playback

- Player UI served via **Workers Static Assets** (free, cached). Player = rrweb-player wrapper + our segment loader.
- API Worker authorizes (org membership) → returns the manifest; segments are streamed **through the Worker from R2** with Cache API (immutable) — repeat views of a hot session are cache hits, saving R2 Class B ops and latency (egress is $0 either way). (Short-lived signed direct-R2 URLs remain a deferred alternative.) **Cache API requires a zone**: it no-ops on `workers.dev`, so the hosted plane runs on our domain and the self-host template treats a custom domain as the recommended default (playback still works without one, just uncached).
- Loader fetches manifest → paints the timeline instantly from the index sidecar → fetches segment 1 → first frame typically < 1 s. Seeking uses segment time ranges; decompression per-batch in a Worker off the player's main thread.
- **One replay, two sources**: the session row, detail URL, and player instance stay stable from the first batch onward. While active, the player combines immutable hello segments, pending batches, and later WebSocket frames. At finalization it adopts the terminal immutable manifest without clearing the visible frame, stops following, and enables normal recorded controls. A small no-store state poll covers missed terminal messages. Exact duration and insights replace provisional details in place.

### Public project pages

- A project owner can publish one page at `/p/{publicId}`. The same combined Worker renders the first HTML with React on the server; there is no second publishing Worker and no static page job.
- D1 stores the publish switch, a random public page ID, and up to ten finalized recordings chosen by the owner. Public URLs never use the private project or session IDs.
- Public analytics responses contain only the project display name, safe totals and breakdowns, and the chosen recording summaries. Error messages, account data, organization IDs, storage keys, and live sessions stay private.
- Every public HTML, JSON, manifest, and segment request checks the current D1 state. Unpublishing, removing a recording, retention deletion, or project deletion therefore blocks the next request. These responses use `no-store`; an already downloaded copy cannot be recalled.
- Public replay manifests replace private IDs with the random public IDs before they leave the Worker. Segment bytes remain opaque and are streamed from R2 without decompression.
- The public browser app uses TanStack Query only for hydration and one-minute refreshes. The replay engine is a separate browser chunk and loads only after a visitor chooses a recording.

---

## 6. Tenancy, self-hosting, and Cloudflare OAuth

Three deployment modes, same codebase:

1. **Hosted (our account)** — multi-tenant. Isolation: per-org D1 database, per-project R2 key prefix, per-key KV config, quotas metered in Analytics Engine. Free tier until limits (sessions/mo + storage GB), then paid. **Dashboard auth: Better Auth** — in-repo OSS auth library, D1-backed, **GitHub OAuth only** (no email/password stack); `members` provide org/project authz, and project write keys carry creator/revoker audit fields. Key revocation commits to D1 before deleting central KV. A durable pending marker retries failed work every five minutes. Every KV writer registers a D1 job first, and a final check is not cleared while an older writer is unfinished, so a failed or terminated settings/key request cannot silently restore stale access. Normal KV edge propagation remains eventually consistent. Key writes are rate-limited, history is capped at 100 rows/project, and revoked audit rows expire after 90 days. The public read-only demo remains anonymous. Considered and rejected: anonymous no-signup capability-token workspaces — unrecoverable lockout on token loss, bespoke security-critical token code, weaker abuse gate than OAuth, and the real onboarding friction is snippet install, not sign-in. Hosted, local, and self-hosted installs all use this same Better Auth flow.
2. **Full self-host** — "Deploy to Cloudflare" button from a **public template repo**. The button auto-provisions DO namespaces, R2, D1, Queues, KV, Vectorize, and Secrets Store from wrangler config — but it **does not deploy multiple Workers from a monorepo** (each would need its own button and repo). So the self-host distributable is `apps/worker` — the **canonical combined Worker** (§1) that mounts the ingest routes, API/dashboard, DO classes, and queue consumer from shared packages. The hot-path-isolation argument for separate Workers doesn't apply to a single-tenant deploy, and because the combined build is canonical rather than derived, it can't rot. CI builds and pushes the template repo from the monorepo on every release so it never drifts, and `wrangler deploy` / `npx orange-replay@latest deploy` remain the power paths (the CLI also handles upgrades and migrations). Ops burden ≈ zero (no servers). Dashboard auth is the same D1-backed Better Auth and GitHub OAuth flow used by hosted installs. Cloudflare Access may be added as an optional outer gate around `/_admin`; it is not an application-auth replacement.
3. **BYOC hybrid** — our control plane (dashboard, billing, updates), their data plane (ingest + storage in their account). Connect flow: Cloudflare does **not** offer public third-party OAuth client registration today (wrangler's OAuth client is Cloudflare's own), so the production connect flow is a **guided scoped API token**: we deep-link to the dashboard token-creation page with a prefilled template (Workers Scripts:Edit, R2:Edit, D1:Edit, Queues:Edit, one account), verify the scopes on paste, store it encrypted, and our provisioner (CF API) deploys and upgrades the data plane. If Cloudflare opens OAuth registration later it slots in as pure UX polish — same provisioner behind it. Recordings never leave their account; we only see metadata they opt into.

**Data residency**: per-project jurisdiction setting → DOs created with `jurisdiction: 'eu'` (a guarantee) and **recording R2 buckets created with `jurisdiction: eu`** (also a guarantee — stronger than location hints, which are only placement preferences). Queues/D1/KV carry only scrubbed sidecar metadata, never replay payloads. R2 Data Catalog does not currently support non-default-jurisdiction buckets, so an EU/FedRAMP project must not use the default-jurisdiction analytics warehouse. It stays on the jurisdiction-safe compatibility backend until Cloudflare supports that catalog, and the product must show that limit plainly.

**Privacy tiers** (per project, sellable): **Standard** — opaque passthrough by default; content-level features are explicit per-feature opt-ins that enable the processing lane (§4). **Strict** — contractual: no server-side inflation ever; sidecar-only features still work (heatmaps, timeline search, trends). **E2E** — payload encrypted with customer-held keys (wire flag bit 1); server-side processing is cryptographically impossible, not just disabled. Competitors inspect everything, always; here inspection is a customer choice with an off switch and a provably-off tier.

---

## 7. Cost model (why this is structurally cheaper)

Per average session (~10 min, ~500 KB compressed, 15 s flush cadence → ~40 batches). Verified against current pricing (requests $0.15/M DO + $0.30/M Workers; duration $12.50/M GB-s _only while actively running — hibernation-eligible idle is free_; DO SQLite rows written $1.00/M):

| Item                                                                                       | Est.                            |
| ------------------------------------------------------------------------------------------ | ------------------------------- |
| Ingest Worker requests (~40) + CPU                                                         | ~$0.000013                      |
| DO requests (~40) + active duration (~1 s total)                                           | ~$0.000008                      |
| DO SQLite rows written (~130: batch inserts + per-append state upserts + deletes + alarms) | ~$0.00013                       |
| R2 PUTs (~3 segments + manifest)                                                           | ~$0.000018                      |
| Queue + D1 control/outbox writes + Pipeline records                                        | measure from production usage   |
| R2 storage (0.5 MB × 30 d)                                                                 | ~$0.0000075/mo                  |
| Playback egress                                                                            | **$0 (R2 zero egress + cache)** |

≈ **$0.15 per 1,000 sessions** all-in at 15 s cadence (~$0.35 at a constant 5 s cadence — this is why flush cadence is adaptive and rows written are minimized), dominated by request pricing and SQLite row writes — versus competitors' ClickHouse clusters + S3 egress. Storage is the long tail at $0.015/GB-mo (→ $0.01 IA; note IA has a 30-day minimum and retrieval fees, so only transition sessions whose remaining retention exceeds 30 d). This is what funds a generous free tier and makes BYOC essentially free for small users (Workers free tier covers hobby traffic).

---

## 8. Failure modes & invariants

- **SDK can't reach ingest** → bounded memory buffer, tiered drop, resume with same seq (server dedupes). Never break the host page: every SDK entry point wrapped; a recorder crash disables recording, not the site.
- **DO 503 / migration** → ingest Worker retries with backoff; batches are idempotent by (session, tab, seq).
- **Queue consumer failure** → per-message try/catch (never fail the whole batch), explicit `ack`/`retry`, DLQ after max retries; the D1 session, exact usage change, and stable analytics outbox rows commit together and are idempotent. The session head remains `finalizing` and the immutable manifest stays playable until a retry commits, so a control-plane delay cannot make the recording disappear.
- **Pipeline or Data Catalog failure** → finalized replay and billing remain available; unsent outbox rows stay visible and retry. Accepted producer retries may make physical duplicates, so R2 SQL keeps one logical row per stable export ID. A schema-invalid or missing row blocks the verified watermark instead of silently losing analytics.
- **R2 SQL failure** → use the last successful cached response marked stale when available, otherwise return `analytics_unavailable`. Never return fake zeroes and never silently switch hosted production back to D1. Rollback is an explicit deployment setting while warehouse writes continue.
- **Session never finalized** (DO alarm loss is near-impossible, but): nightly cron reconciling R2 prefixes without D1 rows → re-emit finalize is DEFERRED (not yet built; retention sweeper is the only cron today).
- **Quota exceeded** (hosted) → KV config flips to `sampling: 0`; KV propagation can take about a minute or more and the edge cache is 30 s, so this is a bounded-lag control rather than an instant global switch. That small overage is priced into plans instead of adding a strongly consistent read to every ingest. Ingest returns 202-and-drop, SDK backs off — never errors in the customer's console.
- **Hot project, not hot session** → per-session DOs shard naturally; the only shared hot resources are KV reads (edge-cached) and the deferred rate-limiter binding (built for this). No coordinator DO on the ingest path.

---

## 9. What we do that others don't (positioning)

1. **Server never inflates your data on the ingest path — and by default, never at all** — compressed on the user's device, stored compressed, decompressed in the viewer's browser. Content-level features (search, detectors, redaction) are explicit opt-ins processed at rest (§4 lane); the Strict tier turns that off contractually and the E2E tier (customer keys, wire bit 1) makes it impossible. "Inspection is your choice, with a provably-off tier" is a stronger enterprise pitch than competitors' always-on inspection.
2. **BYOC self-host in minutes, no infra** — the entire competitor self-host story is docker-compose/k8s + ClickHouse. Ours is a deploy button on a $0–5/mo Cloudflare account.
3. **Live session view by default** — the ingest DO is already a WebSocket hub; live watching + "active now" costs almost nothing.
4. **Instant timeline before any download** — index-sidecar manifests give error/click/rage timeline and skip-inactivity with zero segment fetches.
5. **Edge-native enrichment** — geo/device/bot-score from `request.cf`, no client-side fingerprinting, no IP retention by default.
6. **Semantic session search** (Workers AI + Vectorize) — "find sessions where users got confused by pricing."
7. **Data residency as a checkbox** — DO jurisdictions + R2 location hints, per project.

---

## 10. Build order (all production-grade, sequenced by dependency)

1. `packages/shared` wire format + `apps/worker` spine (ingest routes + `SessionRecorder` DO + R2 + finalize queue + consumer, one Worker).
2. `packages/sdk` recorder with worker-thread compression; conformance tests against the wire format; bundle-size budget in CI (fail > 20 KB gz).
3. `apps/consumer` (D1 writer, retention sweeper) + D1 schema/migrations.
4. `apps/api` + `packages/player` (manifest/timeline first, then segment streaming, then live mode).
5. Hosted multi-tenancy: KV config plane, AE trends, exact D1 metering, quotas, billing hooks, Pipelines → Iceberg lake.
6. Deploy button: CI-mirrored public template repo built from `apps/worker` — since the combined Worker is the canonical build, this is packaging, not a port. The hosted split (`apps/hosted-*`) comes after launch, when hot-path isolation earns its keep.
7. Phase 2: Vectorize semantic search, AI summaries, E2E encryption tier (wire bit already reserved), BYOC provisioner as a Workflow.

Load-test targets before GA: 10 K concurrent sessions/project sustained, batch p99 ingest < 150 ms, first playback frame < 1 s, SDK main-thread time < 5 ms per mutation burst.
