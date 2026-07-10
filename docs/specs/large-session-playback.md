# Large-session playback: checkpoint seeks and bounded work

## Goal

Make multi-hour recordings start and seek without rebuilding from segment zero, while preserving the zero-server-decompression rule. Treat periodic rrweb full snapshots as seek checkpoints, keep only the active checkpoint window in the browser, and keep dashboard analysis outside the playback progress loop.

## Contract changes

- The SDK adds full-snapshot timestamps to the existing uncompressed batch index sidecar. The field is additive and optional so older SDKs and recordings remain valid.
- The Session DO stores that metadata beside the existing sidecar events without changing its SQLite schema or decoding the payload.
- Each manifest segment may publish checkpoint entries containing the timestamp, tab, and batch position. Existing manifests without checkpoint entries continue to use the segment-zero fallback.
- Checkpoint metadata must be bounded and validated against its batch/segment range.

## Player behavior

- Choose the nearest checkpoint at or before the seek target for the recording's primary tab.
- Fetch only the checkpoint-to-target segment range and prefetch the following segment.
- Cancel and ignore stale segment work when a newer seek starts.
- Validate that advertised checkpoints correspond to decoded rrweb full snapshots.
- Rebase at later checkpoints during forward playback so decoded events and loaded-segment bookkeeping stay bounded.
- Enforce encoded segment and active decoded-window byte/event limits before committing data.

## Large-list and analysis behavior

- Dead-click detection must not scan the full replay for every click. Use ordered time indexes and monotonic range cursors.
- Manifest-derived rows, markers, breadcrumbs, and activity buckets are computed only when their source data changes, not on playback progress.
- Keep the timeline sidebar subtree stable during progress updates and defer off-screen row painting.

## Compatibility and safety

- The ingest Worker still never inflates replay payloads.
- R2 objects and the manifest remain immutable.
- No D1 migration is required.
- Old recordings remain playable; they use the existing start-of-session reconstruction until checkpoints are discovered or a newly indexed recording is used.

## Verification

- Unit coverage for wire/schema compatibility, checkpoint propagation, nearest-checkpoint planning, stale-load cancellation, encoded and decoded caps, rebasing, and linear dead-click windows.
- A synthetic multi-hour manifest proves a late seek requests only the checkpoint window.
- Dashboard tests prove static timeline derivation remains stable across progress updates.
- Run `vp check`, `vp test`, the dashboard production build, SDK budgets, and `git diff --check`.
