# Analytics erasure lifecycle owner

Status: implemented

## Goal

Keep every durable transition of `analytics_deletion_jobs` in one module while enforcing two
different policies: recordings are playable for 90 days by default, and scrubbed analytics are
kept for 730 days. The 24-hour physical-removal promise starts when analytics become due or an
explicit privacy deletion is requested.

The owner is `apps/worker/src/analytics/erasure-lifecycle.ts`. The retention sweeper, Pipeline
maintenance, R2 SQL visibility checks, purge HTTP route, and scheduled Spark runner remain
adapters around it.

## Lifecycle

1. The sweeper atomically records the replay deletion fence and the analytics expiry job before
   deleting replay rows and R2 objects. Recording expiry keeps pending session and event exports;
   when a scrubbed sidecar is still needed, replay objects are removed but the sidecar and D1
   source row wait for a successful export. An explicit privacy deletion removes everything and
   marks the fence as an analytics denial.
2. Recording expiry schedules the job for 730 days after session start. The journal creates a
   stable warehouse tombstone only after that due time and saves its export sequence. A job that
   needs a warehouse tombstone can be claimed after either the legacy marker is inside the
   verified warehouse watermark or its replacement deletion-v2 marker has been proved visible.
   The claim names the exact tombstone table that the Spark runner must verify and preserve.
3. The scheduled runner claims the oldest eligible jobs with one `UPDATE ... RETURNING`. A claim
   owns a job for 45 minutes.
4. Physical completion needs two zero-row reports at least ten minutes apart. A late row or an
   error clears that proof. Jobs older than 23 hours produce a rate-limited deadline alert.
5. The versioned deletion stream is a separate visibility track. It keeps selecting required jobs
   after physical completion until every retained deletion is visible in the v2 table.

## Preserved rules

- An explicit privacy deletion can move a scheduled analytics expiry forward, never backward.
- Once a job requires a warehouse tombstone, later requests cannot weaken it.
- The first saved session start time stays stable; explicit privacy deletion remains sticky.
- A repeated request clears only physical completion among the completion fields already handled
  by the existing upsert.
- A tombstone export id includes its due time, so rescheduling an old recording-expiry mistake
  cannot collide with an already published legacy tombstone. Each due job remains stable on retry.
- Physical claim order, claim and report limits, lease duration, quiet period, alert threshold,
  and existing API response fields do not change. Claims add the exact tombstone table.
- Pipeline, R2 SQL, and Spark failures remain retryable and cannot silently complete a job.
- Catalog-owned R2 objects are never deleted directly.
- The Cloudflare Cron Worker starts one named Cloudflare Container. The image already contains
  Java and Spark, and the existing D1 leases make an extra Workflow layer unnecessary. API, Spark,
  remaining-row, tombstone, snapshot, report, and nonzero Container-exit failures stay visible.
  A deadline-only state is a structured warning instead of a repeated synthetic failure.

## Boundary

`scripts/architecture-boundaries.test.mjs` rejects any Worker source file that inserts, updates, or
deletes `analytics_deletion_jobs` outside the lifecycle owner. The owner also cannot import API,
consumer, environment, Pipeline, or R2 SQL adapter modules.

`deletion-journal.ts` and `purge-jobs.ts` remain small compatibility exports so the maintenance and
purge HTTP wrappers keep their existing contracts without owning lifecycle SQL.

## Proof

The real-SQLite lifecycle test covers atomic request recording, sticky request fields, stable
tombstone repair, owner leases, the two-check physical completion rule, and v2 work continuing
after physical completion. Existing journal, v2, purge job, purge API, scheduled runner, and Python
Spark-runner tests remain the regression contract.
