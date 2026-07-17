# Fix: zero-duration sessions and unplayable "ghost" recordings

Status: in progress (2026-07-16). Root-cause analysis first; this spec is the fix contract.

## Problem

Two distinct defects produce `0:00` sessions that the dashboard presents as normal recordings:

1. **Duration measures server arrival, not recorded time.** `SessionState.startedAt`/`lastActivity` are batch `receivedAt` values; `buildSessionManifest` computes `durationMs` from them. A single-batch session (bounce, `pagehide` flush) therefore always has duration 0 even when its batch spans seconds of real events, and every multi-batch session undercounts by the first batch's client-side buffer window (up to `sdkFlushMs`).
2. **The first flushed batch never contains the initial checkpoint.** rrweb emits Meta synchronously at start; the sliced full snapshot lands in a later flush. A session closed after batch 1 (idle-close, hidden tab — paint-aligned slicing stalls without frames —, or bounce) finalizes with one Meta-only batch: zero events, no snapshot, nothing to replay. The server then acks `closed: true`, the SDK rotates, and the real recording lands under a new session id. Nothing in ingest → finalize → index → list filters or marks these.

Verified against local data: 9 Meta-only ghosts (238–239 bytes, `counts.events: 0`), plus 809 sub-second single-batch sessions whose true recorded span (~0.35 s) still displays as `0:00`.

## Fix contract

### F1 — Recorded-time duration (worker)

- The manifest becomes a **recorded-time artifact**: `startedAt` = min segment `t0`, `endedAt` = max segment `t1`, `durationMs = endedAt - startedAt`, all from the per-batch sidecar times already clamped by `clampIndexForStorage` (`session-budgets.ts`). Fallback to server times when there are no segments.
- Trust bound: recorded start is additionally clamped to `state.startedAt - FIRST_BATCH_LOOKBACK_CAP_MS` (5 min) so a skewed/hostile client cannot inflate duration beyond the server-observed span plus a bounded buffer/retry window. Future bound stays `receivedAt + 60s` (existing clamp).
- **D1 ordering/retention semantics do not change**: the finalize queue message keeps server-based `startedAt`/`endedAt` (previous values exactly: `state.startedAt`, `max(state.lastActivity, …t1)`) and gains optional `durationMs` + `hasCheckpoint`. The consumer uses `message.durationMs` when present and falls back to the old server-span computation for in-flight messages produced by the previous DO code (deploy-window compatibility). The analytics export record's existing `duration_ms` field carries the corrected value; no warehouse schema change.
- Player alignment: `manifest.startedAt/durationMs` now match the event timestamps exactly, so timeline offsets map into `[0, durationMs]` without the previous first-buffer skew.

### F2 — `has_checkpoint` fact (worker → D1 → wire → UI)

- At finalize, `hasCheckpoint = manifest.segments.some(s => s.checkpoints?.length > 0)` (checkpoint metadata already flows from the batch index without decompression). Carried on the finalize message (optional boolean).
- D1: migration `0020_sessions_has_checkpoint.sql` adds nullable `has_checkpoint INTEGER` to `sessions` (NULL = unknown, for pre-existing rows and deploy-window messages). Drizzle schema + template mirror updated.
- Wire: `sessionListItemSchema` gains `has_checkpoint: z.boolean().nullable().default(null)` (same back-compat pattern as `activity_hist`). Heads: provisional → `null`; manifest head → computed from segments; exact → from the D1 column.
- **Warehouse reads are deliberately untouched**: `has_checkpoint` goes in a D1-only column list (`d1SessionRowColumns`), the warehouse row mapper returns `null`, and `sessionRowColumns` (shared with R2 SQL) is unchanged. Adding the column to the Iceberg tables is a deferred follow-up gated on the pipeline/stream provisioning steps in `docs/specs/f4-r2-analytics-cutover.md`.

### F3 — SDK: first upload carries the initial checkpoint

- The sink gates **timer and visibility** flushes until the buffer has contained a full snapshot for the current session ("initial checkpoint pending" state, re-armed on session rotation). When the FullSnapshot event is buffered, the sink flushes promptly (new `"checkpoint"` flush reason) so sessions still appear in the dashboard within ~1 s of start rather than waiting for the cadence tick.
- `pagehide`, `manual`, and byte-threshold flushes are **not** gated: unload still ships whatever exists (a real bounce is a real visit; F2 marks it honestly if the snapshot didn't make it).
- Net effect: the common ghost (idle/hidden/bounced before batch 2) either ships its checkpoint in batch 1 or produces a session correctly marked `has_checkpoint = false`.

### F4 — Honest presentation (dashboard)

- Card evidence: exact rows with `has_checkpoint === false` render the existing "Metadata only — nothing to replay" treatment (previously only `segment_count === 0`); `null` keeps today's behavior. Provisional rows with `duration_ms === 0` render "Just started" instead of `0:00`.
- Sub-second exact durations render `<1s` via a session-surface formatter; playback clocks/markers keep `formatDuration` unchanged.
- Session detail: `has_checkpoint === false` shows the existing no-replay empty state instead of mounting a player with nothing to render.

### F5 — Recovery for existing data

`scripts/recover-session-durations.mjs`: offline, reads each session's immutable manifest from the local R2 store (no server, no decompression), recomputes `duration_ms` from segment `t0/t1` and `has_checkpoint` from segment checkpoint metadata (NULL when the manifest predates checkpoint metadata), and updates local D1. Dry-run by default; `--apply` to write. Production: same recomputation runs through the existing analytics backfill/compare tooling per the cutover spec — never raw UPDATEs against the warehouse.

## Regression tests

- DO: single-batch session with a 3 s sidecar span finalizes with `durationMs = 3000` (replaces the weak `>= 0` assertion); Meta-only batch finalizes with `durationMs = 0` **and** `hasCheckpoint = false`; far-future/far-past client clocks stay clamped.
- Consumer: `duration_ms` taken from the message; fallback when absent; `has_checkpoint` column round-trip, NULL for legacy messages.
- Shared: wire schema defaults `has_checkpoint` to `null` when an older response omits it.
- SDK: timer flush held until the full snapshot is buffered; prompt flush on snapshot arrival; pagehide unaffected; gate re-arms on rotation.
- Dashboard: `<1s` formatting; `has_checkpoint:false` → metadata card; provisional 0 → "Just started"; existing continuity tests updated.

## Invariants respected

Ingest still never decompresses payloads; no new alarms or DO writes on the hot path (duration/checkpoint derive from data already persisted); manifests stay immutable (recovery only rewrites D1 rows); warehouse reads keep exact semantics with no silent D1 fallback.
