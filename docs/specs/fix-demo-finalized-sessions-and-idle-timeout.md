# Fix: ten-minute session close and finalized-only customer demo

Status: approved 2026-07-17.

## Goal

Close a session after ten minutes without an accepted recording batch, while keeping the browser
and Durable Object on the same boundary. Keep provisional continuity in signed-in project
Sessions, but make the public customer demo's Sessions page show finalized recordings only.

## Scope

- Change the shared session idle boundary from 30 minutes to 10 minutes. The SDK cookie,
  browser-side idle rotation, Presence expiry, and Session Durable Object close alarm must continue
  importing the same shared value.
- When a Session Durable Object starts with active stored state, reconcile its existing alarm so a
  later pre-deploy close deadline is pulled forward. Do not change tombstone purge alarms.
- Keep the existing 60-second live threshold, two-minute tail flush, batching cadence, and replay
  handoff unchanged.
- In `/demo/sessions`, do not request or merge session heads. The finalized `/sessions` response is
  the only list source.
- An inline `selected` query on `/demo/sessions` may open only an id present in that finalized list.
  Keep the separate `/demo/sessions/:sessionId` route available to `/demo/live`.
- Keep `/demo/live` real-time, and keep signed-in project Sessions using the live/finalizing head
  overlay.

## File budget

- `packages/shared/src/constants.ts`
- `packages/sdk/src/session.ts`
- timeout-focused SDK/Worker tests
- `apps/worker/src/do/session-recorder.ts`
- `apps/dashboard/src/routes/sessions/sessions-panel.tsx`
- `apps/dashboard/tests/sessions-panel-continuity.test.tsx`
- current architecture, install, demo, continuity, and packaging documentation
- `HANDOFF.md`

## Acceptance

1. `CLOSE_SESSION_AFTER_IDLE_MS` and `SESSION_IDLE_MS` are exactly ten minutes.
2. Activity just before the boundary keeps the same browser session; activity at the boundary
   rotates it.
3. A restored active Session Durable Object pulls an obsolete later close alarm forward, while a
   finalized tombstone keeps its purge alarm.
4. Private Sessions still requests session heads and keeps a provisional row visible during a
   warehouse outage.
5. Demo Sessions requests finalized sessions and never requests session heads.
6. A crafted provisional inline selection does not request state or render a pending recording.
7. Demo Live behavior is unchanged.
8. `vp check`, `vp test`, and the changed-scope React Doctor scan pass without a new regression.

## Invariants

No new timer, alarm, hot-path write, dependency, server decompression, authentication path, or
public write surface. The timeout change uses the existing shared contract and alarm.

## Rollout note

A page that loaded the old 30-minute SDK can send one batch after the new Worker has already closed
its session at 10 minutes. The `closed` response rotates that page to a fresh session, but that one
rejected batch is not retried. This is limited to the first post-idle activity during the rollout;
future batches use the new session. Deploy during a low-traffic window and verify the closed-session
rotation metric before treating the timeout rollout as complete.
