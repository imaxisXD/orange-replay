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
 Dashboard/Player ◀──streamed segments (Cache API + immutable)──────────────────┘        ▼
   (Workers Static Assets)                                                  Consumer Worker (batched)
   ▲                                                                          ├─▶ D1: session index (per-org DB)
   └── API Worker ── D1 (search/list) ── Analytics Engine (trends/quotas)     ├─▶ Analytics Engine: metering
                     └─ Vectorize (semantic session search, phase 2)          └─▶ Webhooks / integrations
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
- **Config-driven capture (dashboard-controlled)**: before rrweb starts, the SDK fetches `GET /v1/config` with the public write key. The Worker serves the D1-backed project config through persistent KV with a 60 s edge cache. Sampling, masking/block rules, policy version, and canvas capture apply on that page load with no customer deploy. The SDK keeps local sampling as a ceiling and ignores invalid remote CSS selectors. A timeout, server error, or malformed config fails closed to no recording; only an explicit 404 from an older Worker falls back to local settings for upgrade compatibility. Console/network toggles are stored for the planned lazy capture chunks but do not claim to collect data today. Masking rule sets are versioned (`maskPolicyVersion`) for auditability.

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

- `sessionId` = UUIDv7 stored in `sessionStorage` + first-party cookie; survives SPA navigation and multi-tab (tab id in batch metadata). Idle timeout 30 min → new session.
- Deterministic **sampling decided client-side after the config request and before capture starts**, so unsampled sessions send no replay batches. Server re-checks to prevent abuse.
- `orangeReplay.getSessionUrl()` — returns the replay deep-link for attaching to Sentry/Datadog/console logs.

---

## 3. Ingest path

### Ingest Worker (stateless, hot)

1. **Auth**: write key → project config via **persistent KV** (cached at edge with `cacheTtl: 60`, ~ms). Config carries origin allowlist, sampling rate, quota state, masking rules/policy version, and capture toggles. **On KV miss, read-through to the control plane (D1) before rejecting**; the read-through backfills KV. Dashboard writes replace the KV value instead of expiring it every minute, so steady valid traffic does not churn through D1.
2. **Abuse/rate control**: valid KV hits skip the IP-based unknown-key lookup limiter, so a large office/NAT cannot throttle its normal batches. KV misses and unknown keys use the lookup limiter (300/min/location/IP). Known traffic uses a 60,000 batches/min/location project-key limit plus a 12,000 new-sessions/min/location project limit, sized above the 10K-concurrent-session target at the normal 15 s cadence. The per-session in-DO append limiter, server sampling re-check, quota checks, origin checks, and hard compressed-body cap remain the final boundaries. Cloudflare's rate-limit counters are intentionally approximate and location-local, so billing/quota correctness never depends on them.
3. **Enrichment**: attach `request.cf` (country, city, ASN, bot score if available, TLS) — geo/device data for free, no client lookup, no IP stored by default (GDPR posture).
4. **Route**: `env.SESSION.idFromName(`${projectId}:${sessionId}`)` → RPC `appendBatch(...)`. Per-session DO = natural sharding; a session produces ~0.2 req/s, nowhere near the ~1K req/s per-DO limit. No hot keys.

### `SessionRecorder` Durable Object (one per active session)

SQLite-backed DO. Responsibilities:

- **Ordering & idempotency**: batches keyed by **(tab, seq)** in SQLite — seq counters are per-tab and multiple tabs share one session id, so the tab id must be part of the idempotency key; duplicate (tab, seq) = no-op (SDK and queue retries are safe). Segments order batches by timestamp, not seq (seq isn't globally monotonic across tabs); the player orders by event timestamps anyway. Clock skew: server receive time for session bounds, batch-internal timestamps for playback timing.
- **Buffering**: append compressed batch rows (each ≤ 1 MB, well under the 2 MB value limit). Each append costs two billed SQLite row writes — the batch insert plus the session-state upsert (durability for dedupe counters); collapsing the state write is a known optimization — fewer, larger batches are strictly cheaper, which is what the SDK's adaptive cadence delivers. At **≥ 1 MB buffered or 30 s**, flush a **segment** to R2 and delete flushed rows (stay far from the 10 GB DO cap; steady-state DO storage is ~1 segment).
- **Live mode**: viewers connect via WebSocket (**hibernation API only — `ctx.acceptWebSocket()`, never `accept()`**) to the same DO; incoming batches are broadcast as-is — live session watching is nearly free because the DO is already awake. Attachments (`serializeAttachment`) carry viewer identity across hibernation. `appendBatch` returns `viewerCount > 0`, which the ingest Worker relays to the SDK as the `live` flag (adaptive flush cadence).
- **Live join checkpoint**: broadcast-as-is means a viewer joining mid-session would only ever see incremental mutations it cannot build a DOM from (rrweb full snapshots exist only at record start). So on viewer connect the DO sets a checkpoint flag; the next ingest ack carries `checkpoint: true`, the SDK responds with `takeFullSnapshot()`, and the keyframe arrives as a normal batch within one live-cadence flush (~4 s worst case). The player's follow mode buffers WS frames and starts rendering at the first full snapshot. Zero R2 reads, no timers, one boolean on an existing response — the cost profile of live watching is unchanged.
- **Finalization**: one alarm, queue-pattern for both deadlines (idle 2 min for flush-tail, 30 min for session close). **Don't reset the alarm on every append** — each `setAlarm()` is a billed SQLite row write; keep the next-fire time in memory and only re-arm when it drifts past the deadline or after a cold start (`getAlarm()` on construct). On close: flush remainder, write `manifest.json` to R2, emit `session.finalized` to the Queue, `storage.deleteAll()`, let the DO evict. DO storage cost is transient by design.
- **Async interleaving**: SQLite ops are synchronous (`ctx.storage.sql`) so append is race-free without `blockConcurrencyWhile` on the hot path.
- **Hibernation eligibility is a billing invariant**: DO duration is billed only while actively running or while pinned in memory _unable_ to hibernate — hibernation-eligible idle time is free. So: hibernation WebSockets only, no `setTimeout`/`setInterval` outliving a request (alarms instead), no long-polling. Break this and a 10-minute session bills ~75 GB-s of duration instead of ~1–2 s of active CPU time — a ~50× cost difference on the single biggest line item.

### `PresenceRegistry` Durable Objects (16 per active project)

Live presence is split deterministically by session id across 16 DO names (`project:presence:0..15`). A heartbeat or remove touches exactly one shard; live-list and install-status reads fan out in parallel and merge the results. At the 10K-session target this changes the worst case from one project-wide DO receiving roughly 500 heartbeat writes/s to about 31 writes/s per shard, without adding a global coordinator. A shard outage degrades the live list instead of blocking recording; the session DO remains the source of recording truth.

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

- Segments and manifests are **immutable** (manifest written once at finalize; live playback reads from the DO instead) → aggressive edge caching, `cache-control: immutable`.
- Retention: age-based R2 lifecycle to Infrequent Access at 30 d; per-project retention (differs per plan) enforced by a **retention sweeper** (hard-deletes D1 rows — no tombstone in v1; cron Worker → D1 query for expired sessions → R2 batch delete ≤ 1000 keys + D1 tombstone). Don't rely on lifecycle rules for per-tenant policy.

---

## 4. Index, search, analytics

- **D1, fixed shard set — not one DB per org.** D1 bindings are static (declared in wrangler config); you cannot bind to a dynamically created per-org database without a redeploy, and the HTTP API fallback adds latency and token sprawl. So: hosted plane runs `IDX_00…IDX_15` shard bindings; an org is assigned a shard at creation (stored in its KV/control-plane record). Session index rows are ~300 bytes → a 10 GB shard holds ~30M sessions; add shards ahead of demand, give whale/enterprise orgs a dedicated shard, use read replicas for dashboard latency. Self-host is one org = one D1 — same code, shard count 1. Revisit per-org DBs if/when dynamic D1 bindings ship. Tables: `orgs`, `projects`, `keys`, `members` (deferred with OAuth — not in v1 schema), `sessions` (id, started/ended, duration, anon user id, geo, device, browser, entry url, url count, click/error/rage counts, size, segment count, sample flags), `session_events` (sparse: errors, customs — for filtering "sessions where X happened"). All writes flow through the **Queue consumer in batches** (`db.batch()`), never per-request — D1 write pricing and throughput both favor this; every write is an idempotent upsert keyed by session id.
- **Analytics Engine for trends, D1 for money.** AE takes fire-and-forget `writeDataPoint` from the ingest Worker (per-project volume, bytes, error trends) and powers dashboards + _soft_ quota signals — but AE is sampled at high volume and writes can fail silently, so it is never the billing source. **Exact metering**: `session.finalized` carries exact byte/segment counts → the queue consumer upserts per-project monthly rollups in D1 (idempotent by session id) → billing and hard quota flips read those rollups. Quota flip = KV config write, enforced at edge on the next config read.
- **Phase 2 — semantic search**: at finalize, Workers AI generates a session summary ("user tried checkout 3×, card form errored twice, rage-clicked submit") + embedding → **Vectorize**. Query: "show me sessions where users struggled with checkout." No competitor's self-host tier has this.
- **Opt-in processing lane** (per-project, off by default, dashboard toggle): segments are just gzip in R2, so features that need recording _content_ — full-text session search, dead-click/form-abandonment detectors, post-hoc selector redaction — run as an async consumer that inflates segments **at rest**, writes derived data to D1/the lake, and discards the inflated bytes (Workflows drives historical backfills, so a newly shipped detector applies to already-stored sessions too). The ingest path never inflates anything regardless of toggles; the lane is off contractually on Strict-tier projects and cryptographically impossible on E2E ones. **Heatmaps notably don't need this lane** — clicks/scroll-depth with normalized coordinates are already in the sidecar, so heatmaps are pure aggregations over the lake rendered as overlays at view time.
- **Pipelines → Iceberg → R2 SQL, from day one on the hosted plane**: the ingest Worker fire-and-forgets index-sidecar events into a Pipelines stream (off the hot path, `ctx.waitUntil`), SQL transform, Iceberg sink in R2 Data Catalog, queried via R2 SQL — funnel-ish analytics without ClickHouse, and the lake accumulates history from launch so future analytics features ship with data already behind them. Open beta priced at just R2 storage/ops; the self-host template ships with it disabled by default until GA. Nothing touches the SDK or wire format either way.
- **Queues, not Workflows, on the per-session path.** The async plane is one cheap fan-out step per session at very high volume — exactly Queues' shape (batches of 100, 5K msg/s, ~$0.0000012/session). Workflows buys durable _multi-step_ execution (retries per step, sleeping for days), which the per-session path doesn't need and shouldn't pay for at millions of instances. Workflows earns its keep in the control plane instead: the **BYOC provisioner/upgrader** (deploy → verify → migrate → roll back, per customer account) is a textbook Workflow. The inverse also holds — **Queues can't replace the session DO**: no partition keys, no per-key state or timers, 128 KB message cap, and at 3 ops/message a queue hop costs ~8× a DO RPC. The DO assembles the session; the Queue delivers the fact that it finished.

---

## 5. Playback

- Player UI served via **Workers Static Assets** (free, cached). Player = rrweb-player wrapper + our segment loader.
- API Worker authorizes (org membership) → returns the manifest; segments are streamed **through the Worker from R2** with Cache API (immutable) — repeat views of a hot session are cache hits, saving R2 Class B ops and latency (egress is $0 either way). (Short-lived signed direct-R2 URLs remain a deferred alternative.) **Cache API requires a zone**: it no-ops on `workers.dev`, so the hosted plane runs on our domain and the self-host template treats a custom domain as the recommended default (playback still works without one, just uncached).
- Loader fetches manifest → paints the timeline instantly from the index sidecar → fetches segment 1 → first frame typically < 1 s. Seeking uses segment time ranges; decompression per-batch in a Worker off the player's main thread.
- **Live view**: WebSocket to the session DO; batches decompressed client-side and fed to the player in follow mode. Also enables "user is on the site right now" support workflows (co-browse-lite).

---

## 6. Tenancy, self-hosting, and Cloudflare OAuth

Three deployment modes, same codebase:

1. **Hosted (our account)** — multi-tenant. Isolation: per-org D1 database, per-project R2 key prefix, per-key KV config, quotas metered in Analytics Engine. Free tier until limits (sessions/mo + storage GB), then paid.
2. **Full self-host** — "Deploy to Cloudflare" button from a **public template repo**. The button auto-provisions DO namespaces, R2, D1, Queues, KV, Vectorize, and Secrets Store from wrangler config — but it **does not deploy multiple Workers from a monorepo** (each would need its own button and repo). So the self-host distributable is `apps/worker` — the **canonical combined Worker** (§1) that mounts the ingest routes, API/dashboard, DO classes, and queue consumer from shared packages. The hot-path-isolation argument for separate Workers doesn't apply to a single-tenant deploy, and because the combined build is canonical rather than derived, it can't rot. CI builds and pushes the template repo from the monorepo on every release so it never drifts, and `wrangler deploy` / `npx orange-replay@latest deploy` remain the power paths (the CLI also handles upgrades and migrations). Ops burden ≈ zero (no servers). Dashboard auth for self-host defaults to **Cloudflare Access** in front of the API routes — enterprise SSO with no auth code to run.
3. **BYOC hybrid** — our control plane (dashboard, billing, updates), their data plane (ingest + storage in their account). Connect flow: Cloudflare does **not** offer public third-party OAuth client registration today (wrangler's OAuth client is Cloudflare's own), so the production connect flow is a **guided scoped API token**: we deep-link to the dashboard token-creation page with a prefilled template (Workers Scripts:Edit, R2:Edit, D1:Edit, Queues:Edit, one account), verify the scopes on paste, store it encrypted, and our provisioner (CF API) deploys and upgrades the data plane. If Cloudflare opens OAuth registration later it slots in as pure UX polish — same provisioner behind it. Recordings never leave their account; we only see metadata they opt into.

**Data residency**: per-project jurisdiction setting → DOs created with `jurisdiction: 'eu'` (a guarantee) and **R2 buckets created with `jurisdiction: eu`** (also a guarantee — stronger than location hints, which are only placement preferences). Queues/D1/KV have no jurisdiction controls, so the recording payload never touches them — they carry only the scrubbed sidecar metadata (ids, counts, timestamps, query-stripped URLs; see §2), which is what keeps the residency story honest. Sellable compliance feature competitors bolt on late.

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
| Queue + D1 batch writes + AE points                                                        | ~$0.000015                      |
| R2 storage (0.5 MB × 30 d)                                                                 | ~$0.0000075/mo                  |
| Playback egress                                                                            | **$0 (R2 zero egress + cache)** |

≈ **$0.15 per 1,000 sessions** all-in at 15 s cadence (~$0.35 at a constant 5 s cadence — this is why flush cadence is adaptive and rows written are minimized), dominated by request pricing and SQLite row writes — versus competitors' ClickHouse clusters + S3 egress. Storage is the long tail at $0.015/GB-mo (→ $0.01 IA; note IA has a 30-day minimum and retrieval fees, so only transition sessions whose remaining retention exceeds 30 d). This is what funds a generous free tier and makes BYOC essentially free for small users (Workers free tier covers hobby traffic).

---

## 8. Failure modes & invariants

- **SDK can't reach ingest** → bounded memory buffer, tiered drop, resume with same seq (server dedupes). Never break the host page: every SDK entry point wrapped; a recorder crash disables recording, not the site.
- **DO 503 / migration** → ingest Worker retries with backoff; batches are idempotent by (session, tab, seq).
- **Queue consumer failure** → per-message try/catch (never fail the whole batch), explicit `ack`/`retry`, DLQ after max retries; D1 writes idempotent (`INSERT OR REPLACE` keyed by session id).
- **Session never finalized** (DO alarm loss is near-impossible, but): nightly cron reconciling R2 prefixes without D1 rows → re-emit finalize is DEFERRED (not yet built; retention sweeper is the only cron today).
- **Quota exceeded** (hosted) → KV config flips to `sampling: 0`; with KV's ≤60 s global propagation plus `cacheTtl: 60`, worst-case enforcement lag is ~2 min — bounded overage, priced into plans rather than fought with a consistency workaround. Ingest returns 202-and-drop, SDK backs off — never errors in the customer's console.
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
