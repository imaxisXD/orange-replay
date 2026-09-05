# Performance audit — 5 September 2026

Six performance improvements and a further SDK bundle reduction are implemented locally. The SDK follow-up also fixes delayed stylesheet capture defects exposed by new browser tests. This audit covered recorded playback, SDK snapshot memory and page-close work, analytics database requests, replay asset loading, and repeated Sessions requests. The starting checkout was clean at `800b6c0`; unrelated cleanup arrived during the follow-up and was preserved. Nothing was committed or deployed.

## Verified improvements

| Area                          | Before                                                  | After                                   | What the measurement means                                                                      |
| ----------------------------- | ------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Recorded playback, eight tabs | Decode 20,000 events / 2,260,008 bytes                  | Decode 2,500 events / 282,501 bytes     | 87.5% less decoded data in this fixture; compressed download bytes unchanged                    |
| SDK completed snapshot        | Retain 5,978,930 JSON characters after the queue drains | Retain zero snapshot scratch characters | Removes the worker's remaining reference to that text; not a measured browser heap reduction    |
| SDK page close                | Serialize an excluded 1 MB image five more times        | Zero repeated image serializations      | Avoids 5,022,510 characters of synchronous JSON work; packet remains 61,111 bytes               |
| Analytics read checks         | Five D1 calls for five SELECTs                          | One D1 batch for the same five SELECTs  | Four fewer database requests; no claim of lower billed row reads or measured production latency |

### Recorded playback

`packages/player/src/segments.ts` now inspects the validated batch index before decoding a known background tab. `RecordedSegmentLoader` enables this only when the manifest selected the replay tab before the event store was initialized. Old recordings without manifest checkpoints retain their existing decoding behavior.

The benchmark uses actual gzip decompression, JSON parsing, and event validation. Root reran 12 measurements after four warmups: median decode time was **12.01 ms for all tabs and 1.37 ms for the selected tab** on Node 24.20.0. Every run checks the selected event arrays for equality. These are local CPU measurements, not page-load or production percentiles. Single-tab work counts are unchanged.

Regression proof covers skipped background payloads, malformed indexes, selected checkpoint mismatch, and continuation across overlapping legacy tabs. Review caught and fixed the legacy selection mismatch before completion. Cancellation, memory limits, and checkpoint seeking retain coverage.

Browser proof used the real `OrangePlayer`, a real Web Worker with synchronous fallback disabled, and fixture API responses. It played checkpoint 1, paused, sought to checkpoint 2, and sought back. Only the selected tab reached the decoder. The recorded 1600×900 viewport fit the 800×450 stage. No player errors occurred. This exercises the same engine used by private, demo, live-to-recorded, and published replay views; it does not claim those deployments were visited.

### SDK memory and page close

`packages/sdk/src/pipeline/worker-entry.ts` releases `treeChunks` after ownership passes to the event queue. Tests execute the generated worker source and verify consecutive snapshots, exact content and order, gzip, and uncompressed fallback. The 10,000-node reproduction produces the same 49,256-byte gzip payload after the fix.

`packages/sdk/src/sink/pagehide-batch.ts` starts the size search below a candidate whose **encoded body** already failed the limit. It does not use an estimate as proof. The regression preserves the newest 58 sidecar events, the 100-event drop count, and the keepalive limit. A separate comparison of 108 combinations produced identical before/after packet bytes and drop counts.

Impact path: captured events → memory/serialization → unchanged ingest bytes → unchanged storage, decoded events, and visible replay. There are no wire, masking, session-identity, backend, or visible-copy changes.

### Analytics requests

`apps/worker/src/analytics/runtime.ts` batches the existing warehouse, backfill, pending-deletion, privacy-version, and quarantine checks. The optional v2 readiness call remains separate, making that path six calls before and two after.

Root reran both implementations against a disposable, real Miniflare D1 binding. Results matched for old data pins with newer privacy state, missing v2 migration, invalid pins, pending deletions, and quarantine precedence. The source-tree regression also executes the real migration and SQL against SQLite. Rejected batch calls propagate; they cannot return a permissive snapshot. Batch ordering and transactions follow [Cloudflare's D1 contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

Impact path: D1 read state → finalized analytics/cache policy → private/demo stats and session lists, country filters, and published public analytics. SQL, stored rows, authorization, API fields, and error precedence remain unchanged. Existing cache, public-renderer, and response tests cover fresh, stale, unavailable, and deletion states.

In the real dashboard with fixture responses, an Overview gate error displayed “Could not load your overview”; stale results displayed “Analytics may be out of date”; Sessions displayed “Sessions are temporarily unavailable. Try again.” Clicking **Try again** after recovery replaced the error with the correct empty date-range state. These are browser consumer checks, separate from the actual local D1 checks.

### Replay asset loading

`OrangePlayer` now downloads recording segments while optional replay assets load. The loader waits for assets before decoding, rewriting URLs, or showing the frame. Waiting holds only bounded encoded segment bytes. The asset map and asset downloads share a five-second deadline and a separate cancellation signal. Completed assets remain usable; incomplete or late responses cannot change the frame later. Closing the player releases pending work and blob URLs.

The real-browser fixture used a 1,000 ms stylesheet response and a 700 ms segment response. Before the change, the segment request started at 1,010.5 ms and the styled frame appeared at **1,731 ms**. Afterward the segment started at 5.3 ms and the styled frame appeared at **1,029.2 ms**. Both frames used the same correct green text, monospace font, and blob stylesheet, with a real decoder worker and no player errors. These are controlled local observations, not production latency percentiles.

A stalled 60-second stylesheet fixture displayed a readable fallback frame at **5,011 ms**, with no stylesheet URL and no player error. The original site's stylesheet was absent from browser network requests. The fallback deliberately loses the unavailable asset's styling. Tests also prove that completed CSS survives another stalled asset, requests stop at the deadline, and late responses create no blobs.

Impact path: existing authenticated asset/segment API → bounded downloads → asset readiness → decoder and URL sanitizer → shared replay frame. Stored objects, authorization, API fields, size limits, sanitization, and iframe policy are unchanged. Private and demo configurations can use asset routes; hosts without those optional routes do not request assets. The player suite covers old recordings, seeks, overlapping requests, reset, destroy, and live handoff. Browser proof covers the normal styled frame and deadline fallback.

### Sessions polling

`useSessionsPanelData` now refreshes loaded warehouse pages only for an exact head that is absent from those pages and falls within their date range. A slow refresh continues across later head polls instead of being cancelled and restarted. The live-head overlay and tracking still handle newer recordings outside the fixed warehouse date range.

The mounted-panel regression seeded three pages and delivered three identical exact-head polls: the original implementation made **nine extra page requests**; the fixed implementation makes **zero**. Other regressions cover a missing exact row arriving through one refresh, later warehouse versions, out-of-range rows and removal, and slow refresh reuse.

Root also opened the actual private Sessions route with schema-valid fixture responses, clicked **Load more** twice, and polled each head state three times. The browser retained all three loaded rows with zero additional page requests. A newer exact row appeared as `/new-recording` without refreshing the warehouse pages, then disappeared when the head response removed it. Every final head query succeeded without a decode error.

Impact path: unchanged D1/R2 rows and API contracts → existing head/page queries → refresh decision → visible Sessions rows and loading state. Date comparisons match the backend's inclusive `started_at` boundaries. Authorization, filtering, cursor handling, demo behavior, and explicit refresh are unchanged. An in-range exact row below the loaded pagination cutoff can still prompt repeated refreshes; this change does not eliminate every polling-driven read.

### SDK bundle reduction and delayed stylesheets

The SDK already uses chunked traversal for children and same-origin iframes. Explicit SDK profile guards now let its build remove the generic recursive traversal and iframe fallback. General-purpose snapshot exports retain those paths. Delayed stylesheet updates explicitly serialize only link attributes in the SDK; the normal traversal and mutation observer own any script-created children of a link.

The final combined build includes the stylesheet repairs below. Measurements use the same Node 24.20.0 runtime, production build pipeline, and level-nine gzip as the frozen baseline and repository budget check:

| Bundle          |  Before gzip |   After gzip |     Saved | Space below 36 KiB ceiling |
| --------------- | -----------: | -----------: | --------: | -------------------------: |
| ESM             | 36,741 bytes | 36,549 bytes | 192 bytes |                  315 bytes |
| Script-tag IIFE | 36,823 bytes | 36,637 bytes | 186 bytes |                  227 bytes |

This is a **small reduction of about 0.5%**, not a resolution of the bundle budget concern. Both formats remain above the 32 KiB target. No feature was removed, no dependency or extra download was added, and neither budget was raised. Broader option forwarding, enum/build rules, import changes, extra property mangling, and shared validation deduplication did not earn their complexity through measured savings. The isolated experiments and their limitations are retained in the artifact README.

The new built-SDK-to-player tests found two existing causes of missing delayed CSS: a released temporary snapshot mirror could assign the update a different node ID, and an unrelated iframe snapshot could invalidate the page's stylesheet callback. Updates now retain the original link ID, and only a new full checkpoint invalidates a prior full-snapshot callback. A shared publishing check also rejects initial and incremental callbacks after recording stops, the link is removed or blocked, or its document is replaced. This prevents an old callback from emitting CSS into a later recording. A still-valid incremental link can keep its callback across a checkpoint when its node ID is unchanged. Text masking retains the existing stylesheet behavior.

Regression proof covers both generic and SDK profiles. The original serializer fails two of five node-identity cases. The lifecycle suite covers 26 cases, including removed and blocked owners, iframe navigation, full checkpoints, stopped callbacks, a new recording, and text masking. Independent review also held snapshot delivery open and verified that valid CSS stays queued until after the full snapshot in both profiles. These checks prove which CSS reaches the wire; they do not claim that rejected callbacks cannot touch internal serializer metadata before the publishing check.

Six new browser cases execute the actual ESM and IIFE bundles with canvas on and off and with an iframe before or after the delayed stylesheet. They capture the real compressed SDK request bodies and feed those same bytes to `OrangePlayer` through a real decoding worker with synchronous fallback disabled. Initial and final seeks verify visible DOM changes, masked inputs/text, blocked content, iframe and shadow-root text/styles, sealed image pixels, opt-in canvas pixels, both delayed stylesheets, and continued recording afterward. All six fail on the frozen baseline's delayed stylesheet rendering and pass on the final builds. Saved bundle hashes match the final size measurements.

Impact path: page/link lifecycle → snapshot or mutation callback → existing SDK event and compressed wire body → unchanged segment format → shared player decoder, sanitizer, and replay frame → correct late-loaded styles. Backend storage, authorization, and API fields are unchanged. The shared player serves private, demo, published, and live-to-recorded playback; these browser cases exercise recorded playback and seeking, not remote storage or a live WebSocket journey. No product layout, text, controls, or deployment behavior changes. Independent review found no open issue within this scope.

## Final validation

| Check                                               | Result                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `vp install`                                        | Already up to date; no dependency or lockfile changes               |
| `vp check`                                          | Passed; zero errors and six rrweb warnings                          |
| `vp test`                                           | 1,679 tests passed across 217 files                                 |
| Player suite                                        | 194 tests passed across 22 files                                    |
| SDK suite                                           | 180 tests passed across 20 files                                    |
| Analytics runtime/cache/compare                     | 29 tests passed                                                     |
| Sessions continuity/list/view/date tests            | 30 tests passed                                                     |
| Stylesheet identity and lifecycle                   | 31 tests passed; two independent queued-delivery probes passed      |
| Dashboard production build                          | Passed; plugin timing advisory                                      |
| SDK bundle budget                                   | Passed: ESM 35.69 KiB, IIFE 35.78 KiB, loader 1.94 KiB              |
| Browser playback / dashboard states                 | Passed with fixture API data; actual player and decoder             |
| Browser asset overlap / deadline / Sessions polling | Passed with real UI and fixture responses                           |
| Shipped SDK browser suite                           | Six tests passed, including 100,000 elements at 4× CPU slowdown     |
| Built SDK capture-to-player browser suite           | Six tests passed across ESM/IIFE, canvas settings, and iframe order |
| `git diff --check`                                  | Passed                                                              |

The initial pass had 1,644 tests; the follow-up baseline had 1,638 after unrelated cleanup. The asset/Sessions work added ten regressions, and the SDK follow-up added 31, bringing the final total to 1,679. Full gates ran against the combined checkout. Independent reviews found no open issue in the changed paths; browser checks supply the rendering, capture, and pagination evidence.

The six `vp check` warnings comprise the four prior rrweb warnings plus the same `strictNullChecks` configuration warning for each new stylesheet test file. No warning was suppressed. An optional standalone fork `tsc` command also reported seven diagnostics in untouched vendor files; a baseline pass reproduced the same locations and codes. The configured repository check passes. The dashboard build retains its plugin timing advisory, and the SDK budget reports its existing 32 KiB target warnings.

The recorder remains close to its 36 KiB hard ceiling: the IIFE now leaves **227 bytes of headroom**, up from 41. The loader is below its 2 KiB ceiling. Six existing browser tests ran again against the final production IIFE; they check capture completeness, mutations, masking, loader compatibility, frame responsiveness, and large same-origin iframe snapshots. The six additional browser cases prove that captured events render correctly in the actual player.

## Limits and remaining leads

- The existing dashboard server on port 8899 has no working backend/auth setup. Its login error-state trace measured LCP 684 ms and CLS 0.00, without throttling. This is **not a usable dashboard performance baseline**; no production speed claim is based on it. Trace interpretation follows [Chrome's performance guidance](https://developer.chrome.com/docs/devtools/performance).
- React Doctor 0.9.13's initial full dashboard scan returned 178 diagnostics and 2/100. They are a static-analysis inventory, not 178 verified defects. The follow-up Sessions scan reported 90/100, two warnings and no errors; scope differs from the full scan. The remaining warnings concern hook complexity and the guarded query effect. No diagnostic was suppressed. Reviewed Intl caching and toast cancellation warnings already had the required behavior.
- The accepted SDK profile guards yield a small bundle reduction after including the stylesheet repairs. A material capture-build reduction remains a separate structural change; preserve all capture features and require the built-SDK-to-player browser suite as a gate. The experiments did not identify a justified shortcut to the 32 KiB target.
- Production load, remote D1 latency/billing, browser garbage collection, and actual page-close responsiveness were not measured. Published/private/live UI variants were covered by shared code and tests rather than a full live browser journey.

## Reproduce locally

Run from the repository root:

```sh
vp check
vp test
vp run @orange-replay/dashboard#build
vp run budget
vp exec node artifacts/performance-audit-2026-09-05/player-decode-benchmark.mjs
vp exec node artifacts/performance-audit-2026-09-05/warehouse-audit.mjs
cd fixtures/demo-site
SDK_VERIFY_ORIGIN=http://localhost:8899 vp run e2e:sdk
vp exec playwright test --config ../../artifacts/performance-audit-2026-09-05/snapshot-performance.config.mjs
```

The task's ignored `artifacts/performance-audit-2026-09-05/` directory contains benchmark scripts, results, browser fixtures, and validation logs. The SDK reproduction has its own README there. These are local audit artifacts; the regression tests in the source tree are the durable automated checks. `e2e:sdk` builds the production SDK, reuses the supplied running server, and needs no backend. Set `SDK_BUNDLE_DIR` to an absolute saved-bundle directory to test exact prior bytes without rebuilding. After builds finish, run `vp exec node artifacts/performance-audit-2026-09-05/sdk-reduction-measure.mjs` to regenerate the final byte and hash comparison.

Reuse the existing dashboard server. For the playback check, open `http://localhost:8899/@fs/Users/sunny/Desktop/Projects/orange-replay/artifacts/performance-audit-2026-09-05/browser-replay.html`. The result must report `passed: true`, one worker, no errors, and `decodedTabs: ["selected"]`. The dashboard API fixture is an init script for an isolated test tab; it is never installed in the product.

The asset browser fixture is `browser-asset-waterfall.html` in the same served directory. Its module exports `checkAssetLoading({ assetDelayMs: 60_000 })` for the deadline case. Append `sessions-poll-fixture.js` after `dashboard-api-fixture.js` as the init script for an isolated private Sessions tab. After loading three pages, refetch `session-heads` three times and inspect the request log and query success state. Saved JSON results record the exact rows, request counts, asset timing, and styling. `README-sdk-bundle.md` records the rejected bundle experiments. The Playwright audit config reuses the installed runtime and requires no extra dev server.
