# FIX-LIVE-1 — live follow renders nothing for mid-session viewers

Found by the T3.7 gate and confirmed manually: a dashboard viewer opening a LIVE (unfinalized) session sees a permanently empty player — no replayer iframe is ever created. Root cause: rrweb emits a full snapshot only at record start; the DO broadcasts batches as-is; a mid-session joiner receives only incremental events and can never construct a DOM.

The fix is **checkpoint-on-join**, now specified in ARCHITECTURE.md §3 "Live join checkpoint" (read it first). Scope: `apps/worker/src/do/**`, `packages/shared/src/{types,schemas,constants}.ts` (ack contract), `packages/sdk/src/**` (checkpoint response), `packages/player/src/**` (follow-mode snapshot gate), `apps/dashboard/src/routes/session-detail.tsx` (waiting state) — ONLY what each layer strictly needs. Do NOT run git. Keep every cost invariant: no timers/alarms added, no R2 reads on the live path, no decompression server-side.

## 1. Worker (SessionRecorder DO)

- On viewer WebSocket accept (the existing live-WS attach path), set an in-memory + DO-state flag `checkpointRequested = true`. Cold-start safety: persist it in the existing session state row (it already persists state) — no extra writes on the hot path beyond the state you already touch there.
- In `appendBatch`, when the flag is set: include `checkpoint: true` in the `AppendResult`/ingest ack (add the field to the shared `IngestAck` type + zod schema, optional boolean), then clear the flag. At most one checkpoint per join-burst — if more viewers join before the next append, one checkpoint still suffices.
- Wide event: add `checkpoint: true` to the existing `do.append` event fields when signaled (no new event).
- Integration test (`/__test` + unstable_dev pattern): connect a live WS, send an append, assert ack `checkpoint === true`, send another append, assert absent.

## 2. SDK

- On an ack with `checkpoint: true`: call the recorder's takeFullSnapshot (the vendored fork exposes rrweb's `record.takeFullSnapshot()` — wire it through the recorder handle; if the capture entry doesn't re-export it, add the re-export to our fork's capture surface in `packages/rrweb-fork` — that is an allowed 1-export addition, documented in UPSTREAM.md).
- Guard: at most one forced snapshot per 5s (a rejoin storm must not thrash full snapshots — they're the most expensive event type).
- Works in both sinks (WorkerSink and InlineSink) since the ack flows through the shared transport ack path — handle it where the ack is already parsed.
- Unit test: ack with checkpoint triggers exactly one takeFullSnapshot; throttled within the window.

## 3. Player (follow mode)

- Buffer decoded live events; do NOT construct the Replayer until the buffer contains a full-snapshot event (rrweb `EventType.FullSnapshot` — with its preceding Meta event if present). Discard incrementals that precede the first snapshot. From the snapshot on, apply the buffered tail and stream subsequent events (existing follow behavior).
- Emit a new player event `waiting_keyframe` (fired on follow start, cleared when the snapshot arrives) so the UI can show state.
- Unit test: incremental-only frames → no replayer + waiting state; snapshot frame → replayer starts and later frames apply.

## 4. Dashboard (session-detail live view)

- While following and before the first keyframe: centered viewport state — pulsing green dot + `text-[13px] text-muted-foreground` "Connected live — waiting for the next keyframe…". Replace with the replay the moment the player clears `waiting_keyframe`.
- Keep the LIVE indicator behavior from T3.5 unchanged.

## Definition of done

`export PATH="$HOME/.vite-plus/bin:$PATH" && vp check` green at root; `vp test` for the packages you touched EXCEPT the worker integration suite (no workerd in your sandbox — I run it, plus the Playwright gate). Report: files changed, the exact ack/wire field addition, UPSTREAM.md note if the fork surface changed, anything incomplete.
