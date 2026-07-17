# Analytics erasure lifecycle owner

Status: implemented

## Goal

Keep every durable transition of `analytics_deletion_jobs` in one module while preserving the
existing deletion behavior and the 24-hour physical-removal promise.

The owner is `apps/worker/src/analytics/erasure-lifecycle.ts`. The retention sweeper, Pipeline
maintenance, R2 SQL visibility checks, purge HTTP route, and scheduled Spark runner remain
adapters around it.

## Lifecycle

1. The sweeper atomically records the session-deletion retry, the analytics erasure job, and the
   removal of pending session or event exports before deleting replay rows and R2 objects.
2. The journal creates a stable warehouse tombstone and saves its export sequence. A job that
   needs a warehouse tombstone cannot be claimed until that sequence is inside the verified
   warehouse watermark.
3. The scheduled runner claims the oldest eligible jobs with one `UPDATE ... RETURNING`. A claim
   owns a job for 45 minutes.
4. Physical completion needs two zero-row reports at least ten minutes apart. A late row or an
   error clears that proof. Jobs older than 23 hours produce a rate-limited deadline alert.
5. The versioned deletion stream is a separate visibility track. It keeps selecting required jobs
   after physical completion until every retained deletion is visible in the v2 table.

## Preserved rules

- The earliest deletion request time wins.
- Once a job requires a warehouse tombstone, later requests cannot weaken it.
- The first saved session start time stays stable; the latest deletion reason is retained.
- A repeated request clears only physical completion among the completion fields already handled
  by the existing upsert.
- Legacy deletion export ids and sequences remain stable across retries.
- Physical claim order, claim and report limits, lease duration, quiet period, alert threshold,
  validation, and API response fields do not change.
- Pipeline, R2 SQL, and Spark failures remain retryable and cannot silently complete a job.
- Catalog-owned R2 objects are never deleted directly.

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
