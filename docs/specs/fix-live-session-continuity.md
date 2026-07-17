# FIX-LIVE-2 — Continuous session visibility and replay handoff

## Goal

A recording must appear in Sessions after its first accepted batch and keep the same session id,
row, URL, and player until it is deleted. The 10-minute idle timeout remains the session boundary
and crash fallback. It must not create a gap in the product.

## Locked product behavior

1. `Live` means a heartbeat arrived during the last 60 seconds.
2. When that heartbeat becomes old, the same row stays in Sessions and says
   `Final details pending`.
3. The same detail URL remains playable from the bytes already received by the Session Durable
   Object. When activity becomes idle, the same player enables Play and seek over that history.
4. Finalization sends the immutable manifest to an attached player before the live socket closes.
   The player adopts it without changing the route or clearing the visible frame.
5. Final duration, insights, and analytics replace provisional values quietly.
6. R2 SQL metrics and metric-to-session doorways remain finalized-only and exact. Provisional rows
   never change a warehouse cursor or a pinned `warehouse_version` result.

## State model

Do not hide three different facts behind one `live` boolean.

- Activity: `live`, `idle`, `finalizing`, or `complete`.
- Details: `provisional` or `exact`.
- Replay source: `live` or `recorded`.

The stable key is always `(project_id, session_id)`.

## Control-plane contract

### Session heads

Add an authenticated, no-store endpoint:

`GET /api/v1/projects/:projectId/session-heads`

It accepts the normal session filter and sort plus these control values:

- `opened_at`: when this Sessions view opened.
- `warehouse_to`: the frozen upper time of the exact list, only for the rolling default range.
- Up to 100 `tracked_session_id` values from the previous head response.
- The current list's optional `warehouse_version`.

The feed is an operational overlay, not another complete analytics list. It is enabled only for
unpinned `newest` and `duration` views without exact-only filters. Clicks, pages, friction,
metric doorways, and pinned warehouse views stay exact and use `/sessions` only.

The feed returns a bounded `sessions` array from two sources:

1. Presence rows for open sessions. The 60-second TTL decides only whether activity is `live` or
   `idle`; it no longer deletes the row.
2. Exact D1 rows found through capped, indexed candidate ids:
   - session exports above `warehouse_version`;
   - sessions starting after `warehouse_to`;
   - sessions whose first D1 commit (`indexed_at`) is at or after `opened_at`; and
   - ids carried forward from the previous head response until the exact list contains them.

When there is no warehouse watermark, such as a fresh load while R2 SQL is unavailable, replace the
`indexed_at >= opened_at` source with the latest 100 D1 commits from the same project/index-time
index. This bounded fallback also covers deployments where analytics export is disabled. It does
not turn D1 into a complete analytics-list fallback.

The response keeps the normal requested top rows, then retains matching tracked rows under a hard
200-row cap (100 normal plus up to 100 tracked). Previous tracked ids get first priority in the
dashboard's next 100-id request; new heads fill only the remaining space. Presence tracked ids are
partitioned by shard inside the existing 16-request fan-out, and any failed shard makes the whole
head poll fail instead of returning a partial list that could erase a visible row.

Candidate lookup must use the project/kind/export-sequence, project/start-time, and
project/index-time indexes. Fetch and filter only those point candidates, sort the bounded result
in memory, and never run the page's arbitrary filtered/sorted project scan on D1. `indexed_at` is
written only by the first idempotent session insert. Migration 0010 backfills current rows from
`ended_at` so existing recordings remain usable.

The dashboard merges these heads with the exact `/sessions` page by session id. Exact R2 rows win,
then exact D1 heads, then provisional presence heads. The R2 `nextBefore` cursor is never changed.

Presence rows must be bounded and cleaned lazily. Keep a non-finalizing row until the 10-minute
close deadline plus a handoff grace. Mark it `finalizing` after the manifest write. Remove it only
after the queue consumer commits the D1 session and outbox transaction, and retry that queue
message if removal fails. Do not apply the short handoff expiry to a finalizing row: keep it until
confirmed removal, with the recording's retention expiry as a hard fallback. Legacy rows have a
365-day maximum. The API and dashboard still dedupe every overlap by session id.

### One-session state

Add an authenticated, no-store endpoint:

`GET /api/v1/projects/:projectId/sessions/:sessionId/state`

It returns activity, details state, replay source, and the best known metadata. A deletion fence
always returns `404`. A D1 session is `complete/exact/recorded`. A finalizing presence row is
`finalizing/provisional/recorded`. A fresh or idle presence row uses the live replay source.

Provisional rows keep the stable `SessionRow` numeric fields on the wire, but those values are
placeholders for final-only facts. Clients must check `details_state`; the dashboard may show the
known URL, location, device, start/last-seen duration, flags, and activity, but must hide clicks,
errors, rage clicks, page counts, final duration, segment counts, and insights until details are
exact.

Manifest and segment reads may proceed for an authorized project whenever no deletion fence
exists. They must not wait for the finalized D1 row because the manifest and segments can exist
before the queue consumer commits.

## Durable Object and player handoff

The Presence Durable Object stays alarm-free. Its list reads prune old rows lazily. The Session
Durable Object keeps its existing single alarm and hibernating WebSockets. When close begins it
first persists `finalizingAt`; later appends and live joins are rejected while external work is in
flight. Finalization must not hold `blockConcurrencyWhile` across R2, Presence, or Queue calls.

On viewer join, the live hello continues to send immutable segment references. Immediately after
hello, the Session Durable Object sends every still-pending stored batch in `(t0, tab, seq)` order.
This only copies the opaque compressed bytes; the server never decompresses replay data. The
existing next-append checkpoint request remains a fallback.

The player must:

1. Load and decode the hello's segment references in the browser.
2. Start from the newest usable full snapshot.
3. Apply the pending and later live frames once by `(tab, seq)`.
4. When activity becomes `idle`, refresh the live hello, wait for its segment history and pending
   tail to decode, then change the same player from follow mode to review mode. Enable Play and
   seek across that stored history. A failed ticket request, closed socket, or silent refresh must
   fall back within three seconds to replay already received; it must never leave Play and seek
   locked forever. If activity resumes, reconnect and follow again. Do not emit `live_finalized`
   or pretend that the manifest exists.
5. Accept a terminal `finalized` message containing the immutable manifest. The DO sends it
   immediately after the manifest write, before analytics-sidecar or Queue work.
6. Keep the visible replay surface, adopt the final manifest, stop following, enable recorded
   controls, and fill any missing tail from immutable segments.
7. Keep a status-poll fallback in the dashboard in case the terminal socket message is missed.

## Timeout ownership

The SDK must import the shared 10-minute timeout. Do not keep a second numeric definition in the
SDK. Browser rotation and server close both use the same `>=` boundary. Refresh the cross-tab
session cookie on the existing throttled touch write so an actively used session keeps a sliding
10-minute cookie without writing on every event. Before a dormant tab rotates, it must reconcile
with the shared cookie and join the still-active session. A server `closed` response always takes
priority and forces a new id, including when it arrives during that idle reconciliation. Serialize
both changes through one coordinator so they cannot overwrite each other.

Tab ids must come from the random end of UUIDv7, not its timestamp prefix. Two copied tabs opened
in the same millisecond can share that prefix and must still choose different `(tab, seq)` keys.

## Early finalization

Do not add early finalization in this task. Once continuity is fixed, early finalization only makes
exact analytics arrive sooner. A safe version needs a separate per-tab lifecycle contract,
`pagehide/pageshow` and bfcache handling, all-known-tabs-ended tracking, cancellation on any new
append, and SDK rotation after a server close. The existing 10-minute alarm remains the fallback.

## Acceptance checks

1. First accepted batch appears in Live and Sessions within one five-second poll.
2. At live TTL plus one millisecond it leaves Live but stays once in Sessions with final details
   pending.
3. Opening or reloading during the old gap keeps the same URL and plays earlier segments plus
   pending batches.
4. A written manifest remains readable while the queue is held.
5. A committed D1 row remains visible while the warehouse is held, including when analytics export
   is disabled and the 10-minute idle gap means `ended_at` predates the view.
6. When the warehouse watermark advances, its exact row replaces the head without a duplicate or
   missing poll. A row newer than the frozen default `to` remains as a tracked head until the view
   is refreshed with a newer exact range.
7. A connected viewer receives the final manifest and the same player becomes recorded.
8. A disconnected viewer reaches recorded mode through state polling.
9. A warehouse outage keeps session heads visible while analytics remains stale or unavailable,
   never a fake zero.
10. Pinned metric doorways, clicks/pages/friction sorts, exact-only filters, and pagination remain
    exact. Unknown provisional fields are hidden, never treated as zero.
11. A deletion fence blocks the head, state, manifest, segment, and warehouse result.
12. Multi-tab batches remain one row and dedupe by `(tab, seq)`.
13. Static review finds no server decompression, timer, extra Session alarm, or standard WebSocket
    acceptance.
14. A shortened-time full journey passes: record, immediate card, Live expiry, idle Play and seek,
    finalize, and exact replacement on the same URL and player.
15. `vp check`, `vp test`, Worker and dashboard builds, and the existing product browser tests pass.
16. Query-plan tests prove every exact-head candidate source uses its named index and the bounded
    point fetch does not create a project-wide scan or temporary sort, even when the requested UI
    sort is duration.
17. More than 100 unrelated new commits cannot dislodge a previously tracked head, and a deletion
    fence removes both provisional and exact tracked heads.
18. A dormant tab does not replace a session id kept active by another tab. A simultaneous server
    close still wins and rotates exactly once.
19. One failed Presence shard makes the head poll fail; it never returns a partial success that
    removes a cached row. Recording and ingest continue normally.
20. A failed or silent idle-history refresh unlocks local playback, a dormant-tab reload continues
    its sequence, and copied tabs opened in the same millisecond mint different tab ids.
