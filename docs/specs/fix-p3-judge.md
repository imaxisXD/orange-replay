# FIX-P3 — Phase 3 judge-loop fix round (all findings adversarially verified)

Every item below was confirmed against the code with line-level evidence. Implement EXACTLY these; invent nothing beyond them. Scope: `packages/player/**`, `apps/dashboard/**`, `apps/worker/src/{do,api}/**`, `fixtures/demo-site/**` (only §D), plus tests for what you change. Do NOT run git. Keep cost invariants (no timers in DOs, no hot-path writes) and the wide-event logging contract.

## A. Player robustness (packages/player)

1. **Unbounded live-frame buffer** (`src/live.ts:74-88`, state created at `player.ts:48`): `acceptLiveFrame` retains every frame (raw payload included) in `state.frames` forever and grows `state.seen` per frame, re-sorting per insert; nothing ever consumes `state.frames`. Fix: stop retaining payloads — keep only what dedupe/ordering needs. Bound `seen` (e.g. insertion-ordered set pruned to the most recent ~4096 keys) and drop `state.frames` entirely if nothing consumes it (verify; if the recorded-transition path needs frames, use a bounded window and prune `frames` + `seen` together).
2. **Unbounded overlay history** (`src/overlay.ts:69-73,116-119,146-180,196-198`): cursor/click arrays grow forever during live follow; every batch re-sorts full history and recomputes rage over all clicks; every animation frame filters the full array. Fix: bounded windows — retain only points within the longest visual lookback (trail ~2s, clicks ~4s, rage window) behind the latest known time; run rage detection over the bounded click window; draw from pre-trimmed data. Recorded (non-live) playback must still render overlays for the whole seekable session — bound only what the LIVE accumulation path grows (trim relative to the live edge), not the initial manifest-loaded event set.
3. **Seek into a segment gap jumps to end** (`src/segments.ts:41-57`): gaps between `t1[i]` and `t0[i+1]` fall through to `segments.length - 1`. Fix: return the nearest segment (the first segment whose `t1 >= target`, i.e. the upcoming one); add unit cases: gap → next segment, before-first → 0, after-last → last.
4. **Decode timeout permanently disables decoding + orphans pending** (`src/worker-host.ts:60-64,73-83,139-147,149-156`): one timeout terminates the worker; with `allowSynchronousFallback=false` every later decode throws; other pending decodes hang until their own timers. Fix: on timeout/failure, reject ALL pending decodes with a distinct error, then RESTART the worker (fresh instance) instead of permanently disabling; keep the synchronous fallback only for construction-time CSP failure as today. Cap restart attempts (e.g. 3) before surfacing a terminal player `error`. Unit-test: timeout → pending all rejected → next decode works via new worker.
5. **Live reconnect must re-arm the keyframe gate** (`src/player.ts:138-151,520-530,549-562`; DO sets a new checkpoint on rejoin at `session-recorder.ts:451-456,504-512`): after a WS drop, `liveKeyframes.started` stays true so stale incrementals apply against a stale DOM until the fresh checkpoint snapshot arrives. Fix: `connectLive()` on a RECONNECT path calls `startWaitingForKeyframe` (and emits the waiting event) so frames buffer until the next FullSnapshot; the existing keyframe-accept logic then swaps cleanly.
6. **`Math.max(...spread)` RangeError guard** (`src/player.ts:533-540`): batches have no decoded-event-count cap. Replace with a loop/reduce.
7. **O(n²) live merging** (`src/segments.ts:93-119` via `player.ts:271-277`): maintain an incremental `seenEventKeys` set on the player; append only unseen events; avoid full re-sort per live frame (live frames arrive near-ordered — insert-in-place or sort only the appended tail).

## B. Dashboard (apps/dashboard)

8. **Manifest race on navigation** (`src/routes/session-detail.tsx:63-104`): stale responses (esp. the 404→live-fallback second request) can overwrite the newer session's state. Fix: stale-guard the effect (capture a token/`AbortController` in the effect; ignore results when stale; abort on cleanup).
9. **Registry-component violations** (all in-language per docs/design-language.md):
   - `session-detail.tsx:643-666` hand-rolled Skip-idle toggle → the ui/switch `Switch` (same label/size as spec'd).
   - `session-detail.tsx:634-641` speed button → ui/button `Button` (secondary, sm) keeping the mono `1×/2×/4×` label.
   - `settings.tsx:727-757,759-800` `NumberWithSuffix`/`TextInput` re-implement input styling → rebuild on ui/input-group primitives (keep suffix + width + validation behavior).
   - `settings.tsx:590-604` origin chip's raw remove `<button>` → `Button size="icon-sm" variant="ghost"` (chip container itself may stay a styled span).
   - `sessions.tsx:383-404` local `formatShortRelativeTime` → move into `src/lib/format.ts` as the exported short-form helper (dedupe with `formatRelativeTime`), update imports + unit tests.

## C. Worker (apps/worker)

10. **Viewer-connect wide event** (`src/do/session-recorder.ts:441-467`): the live-WS accept/reject path emits no wide event. Add one (`do.viewer_connect` or fold into `do.presence`-style naming: `event: "do.live_connect"`) emitted in `finally` with outcome, session/project ids, and viewer count after accept.
11. **Request-id propagation on live proxy** (`src/api/handler.ts:141-147,280-297`): inject `x-or-request-id` when forwarding to the SESSION DO (clone request/headers as needed for the WS upgrade — verify upgrade still works in the integration test).
12. **Presence first-event seed guard** (`src/do/presence-registry.ts:157-195`): add an in-memory `firstEventSeeded` flag; skip the `INSERT OR IGNORE` after it's known seeded (hibernation reset just causes one redundant idempotent insert — correct by design; note it in a brief comment).

## D. Demo-site rebrand (fixtures/demo-site — user-reported confusion)

13. The fixture's header brand says "Orange Replay", making the intentionally-light demo page look like our product. Rename the visible brand text to **"Signal Board"** (index.html + page2.html header/wordmark; title tags too). Update ANY e2e assertion that references the old header text (check `tests/*.e2e.ts`; the recorded-copy assertions like "Warehouse stock timeline" and "Back to board" stay). Do NOT change the SDK config/keys.

## Definition of done

`export PATH="$HOME/.vite-plus/bin:$PATH" && vp check` green at root; `vp test` green for packages/player, apps/dashboard, packages/shared (worker integration + Playwright are mine to run — do NOT attempt). Report: files changed per section, any item you deviated on and why.
