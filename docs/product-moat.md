# Product moat — what we build that incumbents structurally cannot

Working strategy doc, 2026-07-04. Companion to ARCHITECTURE.md (which explains _how_ the system is cheap and private); this explains _what product features_ those properties unlock, why FullStory/LogRocket/Hotjar/Sentry-Replay/PostHog-class products cannot copy them without re-architecting, and what each costs us to build. Destination: `docs/product-moat.md`.

The through-line: every incumbent runs a **fat central pipeline** — ingest that decompresses everything, a processing tier (Kafka → ClickHouse/warehouse), storage with egress fees, and a seat-licensed viewer. Each moat feature below is downstream of us _not_ having one of those four things.

---

## 1. Record everything, decide later ("the everything-buffer")

**The pain.** Per-session pricing forces customers to sample 1–10%. The support ticket says "checkout broke for me yesterday" and the session isn't there — sampling anxiety is the #1 complaint thread for every replay vendor. Sentry's answer (client-side buffer, upload only on error) loses the sessions where the _user_ saw a problem the SDK didn't classify as one.

**Why they're stuck.** Their COGS per session is real money: decompress-everything CPU at ingest, warehouse rows per event, cross-cloud egress, seat-scaled viewer infra. Sampling isn't a pricing choice, it's their unit economics leaking onto the customer.

**The feature.** Default-record 100% of sessions into a 48-hour rolling buffer. A **promotion rule engine** decides what graduates to long retention: had an error / rage / dead-click; touched a watched funnel step; user id flagged from a support ticket; manual pin from the dashboard. Everything else ages out silently. Retroactivity within the buffer window is the killer property: "show me the session for ticket #4812" _works_ because everything is there for 48h.

**Why it works here.** Our ingest never inflates payloads (pure byte passthrough), a full session is ~2–4 R2 PUTs + ~130 SQLite row-writes ≈ **$0.0004**; storing a 500KB session for 48h in R2 is ~$0.0000005. The sweeper cron already deletes by age — promotion is the same machinery with a second horizon. The SDK needs zero changes.

**Build sketch.** (a) `promoted_until` column + rule table in D1; (b) rules evaluated in the queue consumer at finalize (counts are already in the message); (c) sweeper honors the two horizons; (d) dashboard: pin button + rules editor in settings; (e) buffer-window badge in the sessions list ("expires in 32h — pin?").
**Size:** small-medium. Entirely local-testable. **Risk:** clarity of messaging (people conflate with sampling); storage math at huge scale needs the quota system, which exists.

---

## 2. Zero-code install for Cloudflare-proxied sites (edge injection)

**The pain.** Install friction: every vendor's funnel dies at "now get engineering to add our snippet and deploy." Weeks of waiting for a tag-manager change window.

**Why they're stuck.** They don't own the wire. The only actors who can inject a script without a customer deploy are the CDN/proxy in front of the site — and none of the replay vendors are one.

**The feature.** For any zone already behind Cloudflare (~20% of the web): a Worker (or Snippet) using **HTMLRewriter injects the loader at the edge**. Turn recording on for `app.example.com` from a dashboard toggle — no code change, no deploy, no tag manager. Rollback is the same toggle. For self-hosters it's `wrangler deploy` on one extra worker; for the hosted plane it's a guided "add this Snippet to your zone" flow.

**Why it works here.** HTMLRewriter streams; injecting `<script>` before `</head>` adds microseconds. Our loader is <1KB inline-able, so the injected tag can carry the whole loader — zero extra round trip. Config (key, ingestUrl, sampling) comes from the same KV the SDK already reads.

**Build sketch.** (a) `infra/edge-inject/` worker: HTMLRewriter, content-type guard, opt-out header, CSP-aware (skip if the response CSP would break workers, or auto-append worker-src); (b) loader inlining build step (exists as `buildLoaderSnippet`); (c) docs + template wiring.
**Size:** medium, self-contained, fully local-testable with miniflare serving fake HTML. **Risk:** injecting into pages you proxy is powerful — needs an explicit per-zone allowlist and a visible kill switch; double-injection guard already exists in the loader (`__orLoaderStarted`).

---

## 3. True live + support co-browse ("they're on the site right now")

**The pain.** Incumbent "live" is minutes-delayed batch processing. Support agents ask users to describe what they see; sales wants to know when a hot lead is on the pricing page _now_.

**Why they're stuck.** Central pipelines impose their latency on everything; a live path would be a parallel second system (some built exactly that, badly).

**The feature.** We already have live watching (checkpoint-on-join). Productize the _trigger_ side: a **presence API** (`GET /live?user=<anon-id>`) + webhooks ("session started matching filter X") so a support tool can show a "watch live" button on the open ticket, and an operator can see friction as it happens. Later: cursor-pointing co-browse (viewer→SDK channel is one message type away — the WS is already bidirectional).

**Why it works here.** The recorder DO _is_ a WebSocket hub; presence registry exists; live cadence tightens automatically when watched (ack-driven). Marginal cost of a viewer ≈ zero.

**Build sketch.** (a) filterable presence query (by entry page/user id); (b) outbound webhook on session-start-matching-rule (queue-driven, retry-safe); (c) embeddable "watch" deep link using the existing ticket mint.
**Size:** small. **Risk:** privacy optics of "watch users live" — ship visibly consent-gated per project, log every watch event (we already emit `do.live_connect` wide events — surface them as an audit trail in the dashboard).

---

## 4. Unlimited viewers + replay links that unfurl anywhere

**The pain.** Seat pricing keeps replays away from the people who act on them. Devs screenshot replays into Jira because a PM login costs $39/mo.

**Why they're stuck.** Their viewer tier costs them real compute (decompress + process per view) and seats are their revenue model — unlimited viewing attacks their own P&L.

**The feature.** **Share links**: one click mints a scoped, expiring link to a single session replay; unfurls a thumbnail in Slack/Linear/Jira; opens in a seatless, read-only player page. Optional password/expiry. The moat is pricing structure: viewers are free because serving a replay is a cache hit.

**Why it works here.** Segments/manifests are immutable + edge-cached; the player is a headless package that already runs outside the dashboard; short-lived HMAC tickets exist (extend scope from live-WS to segment reads for a given session). R2 egress $0.

**Build sketch.** (a) scoped ticket variant: `session-read` tickets with TTL days, validated on manifest/segment routes; (b) public player route (no auth shell, token in fragment); (c) OG-image thumbnail — render the first full snapshot to a static preview at finalize (client-side canvas in the dashboard on first view, cached to R2 — avoids server-side rendering entirely).
**Size:** medium. **Risk:** leaked links = leaked recordings — default short expiry, per-project toggle, revocation list in KV, watermark the viewer.

---

## 5. Provable privacy (residency + no-inspection as verifiable claims)

**The pain.** Every vendor says "we take privacy seriously"; DPOs have learned that means nothing. EU residency is an enterprise SKU, and even then usually storage-only — processing still transits elsewhere. Server-side content inspection is _load-bearing_ for their features (search indexes built by decompressing everything).

**Why they're stuck.** Turning off inspection turns off their product.

**The feature.** A per-project **Privacy Report** the customer can hand to their DPO, generated from live config + architecture facts: what is captured (toggle states, masking rules, mask policy version — all already in config), what the server can technically see (payload path never inflated — cite the wire), where bytes live (DO+R2 jurisdiction pinning), who watched what (the live-watch audit trail), and — at the E2E tier, when built — the statement that inspection is cryptographically impossible, not policy-disabled. Pair with the deferred **minimal-sidecar mode** for the strictest tier.

**Why it works here.** The claims are all mechanically derivable from config + code we already have; the report is honest _because_ the architecture is.

**Build sketch.** (a) `GET /api/v1/projects/:id/privacy-report` assembling config + constants into a signed JSON/PDF-ish doc; (b) dashboard page rendering it; (c) jurisdiction setting surfaced in settings UI (backend field exists).
**Size:** small. **Risk:** every claim must stay true — wire this doc's assertions to the conformance checks in CI so the report can't drift from reality.

---

## 6. Ephemeral replay stacks (per-preview environments)

**The pain.** QA finds a bug on a PR preview; there's no recording because nobody points the production replay tool at throwaway environments (cost, data mixing, config pain).

**Why they're stuck.** Spinning up an isolated Kafka+ClickHouse stack per PR is absurd; pointing previews at the prod project pollutes analytics and retention.

**The feature.** `orange-replay preview up` — an isolated, auto-expiring project (or whole worker) per preview deployment. Recordings from preview #123 live in their own prefix, die with the PR, and the replay link lands in the PR thread via CI.

**Why it works here.** A project is a config row + a key; a whole stack is one `wrangler deploy`. Retention=2 days + the sweeper does the cleanup. The template mirror already produces a deployable unit.

**Build sketch.** (a) CLI/script: create project+key via the config API, emit snippet env vars; (b) GitHub Action example that wires it into a preview deploy; (c) auto-delete on PR close (retention alone suffices).
**Size:** small once the hosted/API story exists; today it's a self-host recipe. **Risk:** minimal — this is packaging, not new machinery.

---

## Ranking

| #   | Feature                            | Moat depth                       | Build size | Local-testable now | Order |
| --- | ---------------------------------- | -------------------------------- | ---------- | ------------------ | ----- |
| 2   | Edge injection (zero-code install) | Unique to CF — nobody can follow | M          | yes                | **1** |
| 1   | Everything-buffer + promotion      | Economic moat, direct pain hit   | S–M        | yes                | **2** |
| 4   | Share links / unlimited viewers    | Pricing-model attack             | M          | yes                | 3     |
| 3   | Presence API + co-browse           | Extends an existing lead         | S          | yes                | 4     |
| 5   | Privacy report                     | Trust compounder, cheap          | S          | yes                | 5     |
| 6   | Ephemeral stacks                   | Niche but zero-competition       | S          | yes                | 6     |

---

# The player: state, honest gaps, and where it should go

## What it is today

Headless engine (`packages/player`) + dashboard chrome: instant timeline from the manifest before any bytes load; worker-thread decode; seek-by-segment prefetch; speed/skip-idle; scale-to-fit at any viewport mismatch; overlays (cursor trail, click ripples, rage bursts) transformed with the stage; error markers + event sidebar with seek; live follow with checkpoint keyframe gating and reconnect re-arm; bounded memory for long live watches. Solid debugging-grade playback.

## Honest gaps (ledger-worthy)

1. **Multi-tab sessions interleave into one replayer.** We _record_ multiple tabs correctly under one session ((tab,seq) idempotency), but playback merges all decoded events by timestamp into a single rrweb Replayer. Two tabs = two DOM streams; interleaved they can corrupt the virtual DOM or flicker between documents. Incumbents solve this with per-tab lanes/switchers. Fix shape: thread tab identity from `BatchIndex` through decode (events don't carry it — the segment batch does), then either (a) a tab picker playing one tab's stream, or (b) parallel lanes. (a) is small and correct; do (a) first. **This is the player's one real defect-class item.**
2. **No console/network/DOM-inspect panes** — the capture toggles exist in config but the capture modules are deferred; the player should grow panes when those land (they're the top "why LogRocket over Hotjar" features for developers).
3. Player API polish from the ledger: preloaded-manifest injection, overlay token for teal, published types (.d.ts) for external embedders — matters the moment share links (#4 above) exist.

## Where to take it — three tiers

**Tier 1 — debugging depth (serve the dev who's already here):** tab picker (gap #1); "jump to first error" CTA on load; dead-click detection surfaced as timeline markers (derivable from existing sidecar clicks vs. mutation silence — no new capture needed); inspect mode — click a replayed element, see its selector + the click events that touched it (rrweb mirror lookup, purely client-side).

**Tier 2 — collaboration (serve the team):** timestamp comments/annotations (tiny D1 table, renders as timeline pins); **clip export** — select a range, export an animated capture client-side (replay to canvas → WebM/GIF via MediaRecorder; zero server cost, huge shareability); share links integration (moat #4) with `t=` deep links into a timestamp.

**Tier 3 — intelligence (differentiate):** session digest strip — a pre-scrubber heat lane showing activity/friction density (the design mock's activity bars, computed from the manifest timeline we already have — no payload processing, so it honors the privacy story); "similar sessions" via sidecar-only clustering (deferred Vectorize work, but the feature slot lives in the player).

**Recommended immediate two:** the tab picker (correctness) and clip export (differentiator nobody expects from a self-hostable tool, and it's client-side only — perfectly on-architecture).
