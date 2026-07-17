# SDK recording-session transition owner

Status: complete (2026-07-17).

## Problem

The SDK does not have one owner for changing a browser recording session.

- `index.ts` currently wires the required order through callbacks: drain the old session, reconcile or rotate the id, reset the sink pipeline, then request a full snapshot.
- `session-change.ts` serializes requests, but its callback interface does not own that order. Reordering the callback body can compile and leave the existing tests green while placing a snapshot in the wrong session.
- `WorkerSink.handleSessionClosed()` has a second no-callback path that calls `session.rotate()` and `resetPipeline()` directly. It omits the required post-rotation snapshot.
- The tests cover the coordinator, session manager, sink reset, and recorder snapshot separately. The sink test manually repeats the correct order instead of exercising one owner.

Checkpoint recovery is separate. It requests a required snapshot after a missing baseline; it must not rotate the recording session.

## Decision

Deepen `WorkerSink` as the single owner of recording-session transitions. `InlineSink` inherits the same implementation.

Both transition inputs enter one queue:

1. Browser activity after the idle limit requests cookie reconciliation.
2. A closed ingest acknowledgement requests a forced new session.

The queue owns this exact order:

1. Wait for the active upload and drain buffered old-session data.
2. Reconcile the shared cookie after idle, or force a new session after a closed acknowledgement.
3. When the session id changed, reset the sink pipeline.
4. Request one required full snapshot after the reset.

A closed acknowledgement always wins when it arrives during idle preparation. Repeated close requests may coalesce. The closed-ack handler must enqueue and return; it must not await work that waits for the active flush, because that would await itself.

## Scope

- `packages/sdk/src/index.ts`
- `packages/sdk/src/session-change.ts`
- `packages/sdk/src/pipeline/transport.ts`
- `packages/sdk/src/sink/contracts.ts`
- `packages/sdk/src/sink/worker-sink.ts`
- `packages/sdk/scripts/build-browser.mjs` private-name compaction list
- Focused SDK tests for session change, sink rotation, first-flush behavior, recorder snapshots, and real `init()` wiring

Expected structural result:

- Remove the shallow `session-change.ts` coordinator.
- Remove `prepareForSessionRotation()` and `resetAfterSessionRotation()` from the shared `Sink` interface.
- Give `WorkerSink` one intent-level idle entry point; closed acknowledgements enter the same private queue.
- Remove the independent `session.rotate()` plus `resetPipeline()` fallback.
- Remove the unused `Transport.onClosed` callback; normal upload acknowledgements flow to the sink owner, while synchronous page-hide responses stay ignored as they are today.
- Reuse the existing required-checkpoint callback for the post-change full snapshot.
- Require that snapshot adapter in the internal sink options so a source constructor cannot silently omit it.

No storage, wire, Worker, dashboard, or public SDK interface changes are in scope.

## Required behavior

- Old buffered events are uploaded with the old session id.
- Preserve the bounded drain: wait for an active upload, make one final old-session flush, then change the id. Do not wait for a permanently empty capture buffer on a busy page.
- Capture arriving after that final bounded flush starts keeps the existing best-effort behavior and may be cleared by reset. Preserving it needs a separate post-transition buffer and checkpoint gate, which is outside this structural change.
- A changed session starts at sequence zero.
- The pipeline resets before the required full snapshot is requested.
- Idle reconciliation with the same active cookie does not reset or request a snapshot.
- Idle reconciliation with no active cookie creates one new session.
- A closed acknowledgement during idle preparation creates exactly one new session, one reset, and one required snapshot.
- Both worker and inline transports use the same implementation.
- Page-hide and required-checkpoint recovery behavior remain unchanged.
- Stop, server drop, or worker failure during a drain cancels the pending transition without rotating or requesting a snapshot.

## Regression tests

1. Real sink + session manager: idle with no active cookie drains the old batch, rotates once, resets once, and requests one required snapshot.
2. Real sink + session manager: idle with the same shared cookie does not reset or request a snapshot.
3. Closed acknowledgement: the old batch keeps the old id; the next full-snapshot batch uses the new id and sequence zero.
4. Closed acknowledgement during idle preparation: one rotation, one reset, and one required snapshot.
5. A continuously active capture cannot starve a forced closed-ack rotation.
6. Stop or failure during a pending drain does not rotate or request a snapshot.
7. `init()` composition with the inline transport and mocked rrweb: a closed response reaches the real owner and requests the new snapshot.

Tests must exercise the owner. They must not manually repeat drain, rotate, reset, and snapshot calls.

## Bundle constraint

Do not raise a bundle limit.

- Current active IIFE hard ceiling: `35.50 KiB` in `packages/sdk/scripts/check-budgets.mjs`.
- Starting built IIFE: `36,283` bytes gzipped (`35.43 KiB`).
- Task no-regression ceiling: `36,283` bytes gzipped. The refactor must be byte-neutral or smaller.
- The earlier `35.25 KiB` gate in `HANDOFF.md` was superseded by the stylesheet privacy allowance. The current artifact is already 187 bytes above 35.25 KiB, so this task must not describe that historical value as the active gate.

## Validation

- Focused SDK transition, sink, recorder, and loader tests
- `vp run budget`, with the resulting IIFE at or below 36,283 bytes gzipped
- `vp check`
- `vp test`
- Existing browser journey if the unit and composition coverage cannot prove the real initialization path
