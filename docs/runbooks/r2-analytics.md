# R2 analytics warehouse runbook

## What this runbook changes

This runbook creates a dedicated analytics bucket, enables R2 Data Catalog, and connects one typed Pipeline stream to three Iceberg tables:

- `analytics_sessions`
- `analytics_events`
- `analytics_deletions`

The replay bucket stays separate. Analytics records contain scrubbed summaries and sidecar data only. The setup and backfill scripts never read replay segment payloads.

Cloudflare Pipelines and R2 Data Catalog are beta services. The Data Catalog sink currently adds `__ingest_ts` and day partitioning itself. Treat every table as partitioned even though the sink command has no partition option. This matters for deletion: DuckDB may query the tables, but it is not an approved physical-delete writer for this setup.

The catalog currently supports the default jurisdiction only. Do not provision this path for a project that promises EU or FedRAMP analytics residency.

Warehouse API reads use a 24-hour range when either date boundary is missing. An explicit date range may cover at most 31 days. This keeps every R2 SQL read bounded; callers that need older history must request it in separate windows.

## Files used

- `infra/analytics/stream-schema.json`: the typed union record
- `infra/analytics/pipeline.sql`: the three fan-out statements
- `infra/analytics/resources.production.json`: resource names and sink settings
- `infra/analytics/wrangler.binding.example.jsonc`: Worker binding example
- `infra/analytics/purge_pending.py`: leased Spark deletion runner; dry-run by default
- `.github/workflows/analytics-purge.yml`: scheduled 15-minute physical deletion repair
- `scripts/setup-analytics.mjs`: read-only by default; creates only missing resources with `--apply`
- `scripts/backfill-analytics.mjs`: read-only by default; adds idempotent D1 outbox rows with `--apply`

## Credentials

Use separate credentials:

1. A bucket-scoped catalog maintenance token. Limit it to `orange-replay-analytics-prod` with **Workers R2 Data Catalog Write** and **Workers R2 Storage Bucket Item Write**. Put it in `ORANGE_REPLAY_CATALOG_TOKEN` while running setup. Store the same bucket-scoped token in the protected GitHub Actions environment for Spark deletion maintenance. Never upload it to the Worker.
2. A Pipeline-only catalog token for creating missing Data Catalog sinks. Cloudflare currently rejects bucket-scoped tokens for this operation. It must have account-wide **Workers R2 Data Catalog Write** and **Workers R2 Storage Write** access. Put it in `ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN` only while running setup. Cloudflare saves the credential in each sink, so the token must remain valid while those sinks run. Keep it in the local secret store used for Pipeline setup; never put it in the Worker, GitHub Actions, Workers Builds, or the purge runner.
3. A dedicated R2 SQL query token stored as the Worker secret `R2_SQL_TOKEN`. Cloudflare currently requires R2 SQL read-only, Data Catalog read-only, and R2 storage Admin read/write permissions for queries, so scope it to the analytics bucket even though Orange Replay sends only `SELECT` statements.
4. A dedicated Account API token used only to create the recording inventory. It must be able to read the replay bucket. The helper verifies it, then mints a 15-minute `object-read-only` credential bound to that one bucket for the actual S3 listing.
5. A separate random bearer value shared only by the Worker secret and GitHub Actions secret named `ANALYTICS_PURGE_RUNNER_TOKEN`.

Never put any token in a committed file, report, browser response, or application log, and do not type a token as a command argument. Wrangler accepts the two catalog tokens only through its `--catalog-token` and `--token` command arguments. The setup script reads them from the environment and sends the Pipeline token only to missing-sink creation and the bucket token only to catalog maintenance. Another process running as the same operating-system user may briefly see those arguments. Run setup only on a trusted machine or single-use CI runner, unset both environment values immediately, and do not run it beside untrusted processes. The helper turns off Wrangler disk logs and redacts both tokens if Wrangler returns either one in an error.

## Provision the warehouse

First print the complete plan without reading Cloudflare:

```sh
node scripts/setup-analytics.mjs --offline
```

Then inspect the real account. This is still read-only:

```sh
node scripts/setup-analytics.mjs
```

The output says `keep` for a resource that already exists and `create` for a missing resource. Review the bucket, stream, sink, table, and pipeline names before continuing.

Load the bucket-scoped maintenance token without printing it. If the dry run says `needsPipelineCatalogToken: true`, also load the account-wide Pipeline-only token. Then apply the plan:

```sh
read -s ORANGE_REPLAY_CATALOG_TOKEN
export ORANGE_REPLAY_CATALOG_TOKEN
read -s ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN
export ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN
node scripts/setup-analytics.mjs --apply
unset ORANGE_REPLAY_CATALOG_TOKEN ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN
```

Running the same command again is safe. Existing resources are kept. When all sinks exist, setup does not read or require `ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN`; it still needs the bucket-scoped token to check and apply catalog maintenance settings. The script does not delete or replace a resource because Pipeline schemas, sinks, and SQL cannot be edited in place safely.

Record the Pipeline token expiry in the private production inventory and check it during the monthly warehouse review. Rotate at least 30 days before expiry. Cloudflare cannot replace a Data Catalog sink credential in place, and it does not allow a new sink to attach to the existing table. Safe rotation therefore needs new versioned session, event, and deletion table names; new sinks using the replacement token; a reviewed Pipeline switch; a repeatable backfill into the new tables; the full D1-to-R2 acceptance check; and only then retirement of the old Pipeline, sinks, tables, and token. Never revoke the old token before the replacement warehouse is caught up and serving correctly.

Record the stream ID and warehouse name from the result. Add the stream binding and R2 SQL settings using `infra/analytics/wrangler.binding.example.jsonc`. Store `R2_SQL_TOKEN` as a Worker secret, not as a variable.

Verify each resource after provisioning:

```sh
vp exec --filter @orange-replay/worker -- wrangler r2 bucket info orange-replay-analytics-prod
vp exec --filter @orange-replay/worker -- wrangler r2 bucket catalog get orange-replay-analytics-prod
vp exec --filter @orange-replay/worker -- wrangler pipelines streams get orange_replay_analytics_stream
vp exec --filter @orange-replay/worker -- wrangler pipelines sinks get orange_replay_analytics_sessions_sink
vp exec --filter @orange-replay/worker -- wrangler pipelines sinks get orange_replay_analytics_events_sink
vp exec --filter @orange-replay/worker -- wrangler pipelines sinks get orange_replay_analytics_deletions_sink
vp exec --filter @orange-replay/worker -- wrangler pipelines get orange_replay_analytics_prod
```

Do not send production records until the returned stream schema and Pipeline SQL match the committed files. A structured stream can accept an invalid event and later drop it during processing, so also watch Pipelines user-error metrics after every schema change.

## Deploy warehouse writes while reads stay on D1

After the resources match, deploy the exporter and new D1 tables without moving analytics reads:

```sh
vp run deploy:prod:d1
```

This is the required first step in the `d1 → compare → r2_sql` sequence. It applies pending D1 migrations, starts new warehouse exports, and confirms that the API still reports `d1_rollback`. Do not apply the backfill until this deploy and its two smoke checks pass.

## Build a complete replay inventory

The backfill fails closed without an object inventory. This is what lets it prove missing D1 manifests and orphan R2 manifests.

Use a dedicated Cloudflare **Account API token** that can read objects from the replay bucket. Do not create or keep long-lived S3 access keys. The helper accepts the account token only from `ORANGE_REPLAY_R2_INVENTORY_TOKEN`; there is no token command option.

First inspect the exact plan. Offline mode does not read the token, call Cloudflare, or write a file:

```sh
node scripts/inventory-r2.mjs \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --bucket orange-replay-recordings-prod \
  --report audits/analytics-backfill/production-r2-inventory.json \
  --offline
```

Then load the account token without printing it and create the inventory:

```sh
read -s ORANGE_REPLAY_R2_INVENTORY_TOKEN
export ORANGE_REPLAY_R2_INVENTORY_TOKEN
node scripts/inventory-r2.mjs \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --bucket orange-replay-recordings-prod \
  --report audits/analytics-backfill/production-r2-inventory.json
unset ORANGE_REPLAY_R2_INVENTORY_TOKEN
```

The helper verifies the Account API token to get its parent token ID. It then asks Cloudflare for a 15-minute `object-read-only` credential bound to exactly `orange-replay-recordings-prod`, signs every paginated `ListObjectsV2` request with the returned session token, and keeps all credentials in memory only. The report is created as mode `0600` and contains only sorted, deduplicated `{ "key": "..." }` records. It refuses to replace an existing report, so choose a new path when repeating the inventory.

Keep the inventory private because object keys contain project and session IDs. A failed request reports only the operation and HTTP status; Cloudflare response bodies and credentials are never copied into the report or error.

Create a different inventory file for local Miniflare data. Never reuse the local inventory in a production command and never upload local demo or test recordings to production.

An inventory file may be a JSON array of keys, a JSON object with an `objects` array, or one key per line.

Cloudflare references: [Account-token verification](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/), [temporary R2 credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/), and [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/).

## Dry-run the D1 backfill

Apply all reviewed D1 migrations first. `analytics_export_outbox` must exist before `--apply` can work.

Production dry run:

```sh
node scripts/backfill-analytics.mjs \
  --source production \
  --database orange-replay-idx-00-prod \
  --recordings-bucket orange-replay-recordings-prod \
  --inventory audits/analytics-backfill/production-r2-inventory.json \
  --config apps/worker/wrangler.cloudflare-build.jsonc \
  --env production \
  --report audits/analytics-backfill/production-dry-run.json
```

Local dry run:

```sh
node scripts/backfill-analytics.mjs \
  --source local \
  --database orange-replay-idx-00 \
  --recordings-bucket orange-replay-recordings \
  --inventory audits/analytics-backfill/local-r2-inventory.json \
  --config apps/worker/wrangler.jsonc \
  --report audits/analytics-backfill/local-dry-run.json
```

The report uses disjoint session outcomes:

- `migrated`: live D1 session with a readable, matching manifest
- `deleted`: an active deletion row exists, so the session is skipped
- `expired`: retention has passed, so the session is skipped
- `missing`: D1 points to a manifest absent from the complete R2 inventory
- `invalid`: the manifest cannot be read, parsed, or matched to its key
- `orphanManifests`: R2 manifest has no D1 session
- `sparseSessions` and `sparseEvents`: historical event coverage copied from the capped D1 event list

`migrated + deleted + expired + missing + invalid` must equal `sourceSessions`. `eventCoverage` is deliberately `sparse`; the script does not inspect replay segments to invent old events.

Keep the report's `expiryCutoffMs`. Pass that same value as `--now` during the apply run so a session cannot move from live to expired between review and execution.

Stop if the inventory is incomplete, any production manifest is unexpectedly missing or invalid, or the source is not the intended account.

## Apply and resume the backfill

After reviewing the dry-run report, repeat the same command with `--apply` and a new report path:

```sh
node scripts/backfill-analytics.mjs \
  --source production \
  --database orange-replay-idx-00-prod \
  --recordings-bucket orange-replay-recordings-prod \
  --inventory audits/analytics-backfill/production-r2-inventory.json \
  --config apps/worker/wrangler.cloudflare-build.jsonc \
  --env production \
  --now REPLACE_WITH_DRY_RUN_EXPIRY_CUTOFF_MS \
  --report audits/analytics-backfill/production-applied.json \
  --apply
```

The script commits small `INSERT OR IGNORE` batches. Stable export IDs make a stopped run resumable: rerun the same command. A successful second run reports `outboxRowsInserted: 0` and moves the expected rows into `outboxRowsAlreadyPresent`.

The script only fills the D1 delivery outbox. The Worker exporter sends those rows to Pipelines, and the reconciler advances the warehouse watermark only after R2 SQL sees every stable ID. Do not switch reads merely because the outbox insert completed.

## Cross-check before cutover

Keep production on `ANALYTICS_READ_BACKEND=d1`, then use `compare` mode. For each project and day compare:

- exact session IDs;
- session count;
- byte, click, error, and rage sums;
- sparse event count;
- highest verified export sequence.

For every shared session, also compare the exact duration, page and URL counts, location, device, browser, operating system, entry URL, insight values, activity histogram, storage values, expiry, and export sequence. A matching daily total cannot hide a changed session row.

The R2 query and the D1 comparison must use the same verified `warehouse_version`. Use the automated verifier below.

First validate the acceptance script without contacting Cloudflare or writing a report:

```sh
node --check scripts/verify-analytics-backfill.mjs
node scripts/verify-analytics-backfill.mjs --offline
vp test scripts/analytics-acceptance.test.mjs
```

Then export a separate R2 SQL query token scoped to the analytics bucket. The script accepts the token from the environment only; it has no token command option. It hardcodes remote, read-only D1 queries and submits only guarded `SELECT` queries to the current R2 SQL REST API. Cloudflare currently also requires R2 storage Admin read/write on this query token even though this script never calls a write API, so keep the token short-lived and bucket-scoped. The script never writes an outbox row, watermark, or backfill completion:

```sh
read -s ORANGE_REPLAY_R2_SQL_READ_TOKEN
export ORANGE_REPLAY_R2_SQL_READ_TOKEN
export R2_SQL_ACCOUNT_ID=REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID

node scripts/verify-analytics-backfill.mjs \
  --database orange-replay-idx-00-prod \
  --bucket orange-replay-analytics-prod \
  --config apps/worker/wrangler.cloudflare-build.jsonc \
  --env production

unset ORANGE_REPLAY_R2_SQL_READ_TOKEN
```

By default the command writes a private, timestamped JSON file under `audits/analytics-acceptance/`. Keep this file as the cutover artifact. It contains the D1 and R2 session IDs, exact UTC-day totals, and exact per-session field differences. It starts from every current non-deleted D1 session, so a missing session export cannot disappear from both sides and falsely pass.

The verifier freezes one expiry cutoff at startup and fails if D1 still has an expired session without a deletion marker. This avoids comparing a session that the backfill correctly skipped as expired. If `expiredUnsweptSessions` is above zero, run the retention sweep and repeat the verifier.

The verifier also pages through every expected D1 outbox or ledger export up to the verified watermark. For each stable export ID, it requires R2 SQL to return the same sequence, session, and record kind from the correct table, with all required fields present. Matching only the highest sequence is not enough because an earlier export could still be missing.

Deletion is the deliberate exception to the fixed watermark snapshot. Session and event rows stay at or below the selected `warehouse_version`, but every published deletion tombstone hides its session even when the tombstone is newer. Privacy removal is more important than reproducing an older visible result. The verifier reads D1 again after the R2 queries and fails if the source, receipt, deletion count, residency, session set, or watermark changed during the check.

The command exits nonzero for a missing completion receipt, incomplete Pipeline visibility, missing export, cross-project R2 row, changed source, or any ID, total, or sequence mismatch. Do not continue to `r2_sql` after a nonzero result. You may repeat `--project PROJECT_ID` to check a smaller reviewed set, or pass `--report PATH` to choose the private report path.

After the automated report matches, also prove:

1. Sending every outbox record twice still returns one logical row per `export_id`.
2. A failed Pipeline send leaves the outbox row ready for retry.
3. A schema-invalid test record appears in Pipeline user-error metrics and does not advance the watermark.
4. A new recording can be played directly while analytics is unavailable.
5. A published deletion hides the session before physical cleanup.

Only set `ANALYTICS_READ_BACKEND=r2_sql` after the comparison is exact and the browser dashboard journeys pass.

## Deploy, cut over, and roll back

The committed production config does not choose a backend. The config generator requires one explicit choice, so a normal deploy cannot silently reset production to D1. The earlier D1 deploy is the reviewed starting point for the steps below.

After the backfill verifier passes, deploy comparison mode:

```sh
vp run deploy:prod:compare
```

After comparison mode and the browser journeys pass, switch reads to R2 SQL:

```sh
vp run deploy:prod:r2-sql
```

This command runs a new full acceptance verifier immediately before Wrangler deploy. A missing token, expired unswept row, changed field, missing export identity, or any D1/R2 mismatch stops the deploy before the serving backend changes. The verifier accepts the same `ORANGE_REPLAY_PROD_R2_SQL_TOKEN` used for the Worker secret, or the separate `ORANGE_REPLAY_R2_SQL_READ_TOKEN` described above.

If R2 SQL must be removed from the serving path, roll back reads to D1:

```sh
vp run deploy:prod:rollback
```

Rolling back changes the analytics serving choice to D1. It does not stop warehouse export, remove R2 data, or reverse D1 migrations. Every command above is still a normal production deploy: it builds, applies pending D1 migrations, deploys with `--keep-vars`, runs the normal production API smoke check, and then runs the analytics smoke check. Keeping remote variables is required because the generated config does not repeat every existing production setting, such as demo values. The analytics smoke proves the expected state, checks the complete sessions doorway, and checks one reported count doorway when one exists. The API integration tests cover the full metric-doorway contract without turning every production deploy into dozens of live reads. In `r2_sql` mode the smoke requires a fresh warehouse response; a stale cached response fails the deploy command.

The full acceptance gate runs only for `r2_sql`. Compare, D1, and rollback deploys skip it, so a failed acceptance check cannot block a D1 rollback.

The base `vp run deploy:prod` command deliberately fails unless `ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND` is set to `d1`, `compare`, or `r2_sql`. For a no-upload check, choose the mode in the same command:

```sh
ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND=compare vp run deploy:prod:dry-run
```

Cloudflare Workers Builds must keep `ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND` as an explicit build variable and run `vp run deploy:cloudflare-build`. When that value is `r2_sql`, store `ORANGE_REPLAY_PROD_R2_SQL_TOKEN` as a protected build secret so the pre-deploy acceptance gate can query R2 SQL. Change the backend only as part of a reviewed cutover or rollback. To repeat only the analytics smoke check after a deploy, use the same backend value:

```sh
ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND=compare vp run analytics:smoke:prod
```

## Physical deletion within 24 hours

The warehouse deletion tombstone hides a session immediately. Physical removal is a separate job that must finish within 24 hours. Never delete Data Catalog metadata, manifests, snapshots, or Parquet objects through the R2 object API. Iceberg owns those files, and direct deletion can corrupt the catalog.

The automated path is:

1. The D1 deletion journal keeps the request after the source session and replay objects are gone. It also saves whether the session used the default warehouse. Removing or changing the project later cannot weaken that saved requirement. An old job with missing context defaults to requiring a tombstone.
2. The Worker runs the normal analytics maintenance every five minutes. It runs the retention sweep every 15 minutes at `7,22,37,52 * * * *`, offset from maintenance, so an expired D1 session is not left waiting for a once-daily sweep.
3. Each `POST /internal/analytics/purge/claim` call leases up to 500 eligible jobs for 45 minutes. A job whose saved requirement says it used the default warehouse is not eligible until its tombstone is inside the verified watermark.
4. The GitHub workflow runs every 15 minutes. One run reuses one Spark session, handles at most 4,000 jobs in bounded groups of 500, and stops claiming after 20 minutes. The runner target is 30 minutes. The workflow's 40-minute timeout is a hard safety cap, not a safe point to stop Spark work early; do not add forced in-process preemption. The lease is 45 minutes so an interrupted run can be retried safely.
5. For each group, Spark counts all sessions with two grouped queries. It then runs one delete for `analytics_events` and one for `analytics_sessions`, instead of scanning both tables once per session.
6. Spark rewrites each changed data table once per 500-job group with a `where` filter limited to those project/session pairs. The rewrite applies even a single merge-on-read delete marker. Spark then expires old snapshots with `retain_last => 1` and verifies every session with grouped count queries.
7. The runner reports results in groups of 20 to `POST /internal/analytics/purge/report`, then releases those leases. Finding a new row moves the first-zero proof to this run even when cleanup succeeds.
8. D1 completes the job only after two zero-row reports at least ten minutes apart. While a job waits for its second check it cannot be claimed again, so it does not block other work. The second zero check does not repeat compaction when no new rows were deleted. A late Pipeline row resets that proof and is deleted on the next run.

`analytics_deletions` is never deleted. It is the durable deny that prevents a late accepted Pipeline row from making the session visible again. `rows_remaining` counts only event and session rows.

The runner keeps every claimed job leased until the claim loop ends. This includes a job whose Spark delete failed, so one repeatedly failing oldest job cannot be reclaimed and block later batches in the same run.

The capacity check uses the slow overlap case, not 96 ideal cron starts. A 40-minute workflow can leave only 36 completed runs per day under the single-run concurrency rule. At 4,000 checks per run and two checks per session, that is room for 72,000 completed session deletions per day. The supported bulk-delete limit is therefore 50,000 sessions, leaving 22,000 sessions of headroom. The automated test locks these numbers together. A production load test must still show that one 500-session Spark group and one full run stay inside their budgets before the scheduled job is enabled.

### Configure the runner

Generate one separate runner secret and load it with the other production deployment secrets:

```sh
export ORANGE_REPLAY_PROD_ANALYTICS_PURGE_RUNNER_TOKEN="$(openssl rand -base64 48)"
node scripts/check-prod-secret.mjs --validate-only
```

The deploy script uploads it as the Worker secret `ANALYTICS_PURGE_RUNNER_TOKEN`, then checks the uploaded secret names with `wrangler secret list`. Wrangler's `secrets.required` setting helps local type generation and warnings; it is not a hosted deployment gate. Put the exact same value in the GitHub Actions secret `ANALYTICS_PURGE_RUNNER_TOKEN`.

Create a GitHub environment named `production-analytics` before enabling the scheduled workflow. Limit that environment to the production branch, then store all values below at environment scope. Do not add a required manual reviewer to the scheduled job: a run waiting for approval cannot meet the 24-hour deletion deadline.

Configure these GitHub Actions values for `.github/workflows/analytics-purge.yml`:

| Kind     | Name                           | Value                                   |
| -------- | ------------------------------ | --------------------------------------- |
| Variable | `ORANGE_REPLAY_PURGE_API_URL`  | Exact production Worker HTTPS origin    |
| Variable | `R2_CATALOG_URI`               | R2 Data Catalog REST URI                |
| Variable | `R2_SQL_WAREHOUSE`             | Catalog warehouse returned during setup |
| Secret   | `ANALYTICS_PURGE_RUNNER_TOKEN` | Same random value stored in the Worker  |
| Secret   | `ORANGE_REPLAY_CATALOG_TOKEN`  | Bucket-scoped catalog maintenance token |

The bucket-scoped catalog token belongs only in the protected `production-analytics` workflow secret. Do not put it in Worker variables, logs, user-entered command arguments, or committed files. Never store the account-wide `ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN` in GitHub; it is only for local Pipeline sink setup.

### Dry-run and execute

The runner is a true dry run by default: it makes no API, Spark, or catalog call.

```sh
python3 -m unittest infra.analytics.test_purge_pending
python3 infra/analytics/purge_pending.py
```

Use the GitHub workflow's manual `execute` choice for a reviewed manual run. Scheduled runs always pass `--execute`. The old `infra/analytics/purge_session.py` entry point is disabled because a manually chosen session could skip the D1 lease, watermark, and two-check proof.

The runner validates IDs before building SQL, reads both secrets from the environment, and never prints either token. It claims up to 500 jobs per API call, handles up to 4,000 jobs in one scheduled run, and reports at most 20 results per API call. Spark failures, remaining rows, missing required tombstones, and snapshot-expiration failures are reported to D1. A missing secret or API failure fails the workflow; an unreported lease expires safely for retry. A job older than 23 hours records a rate-limited deadline alert and exits non-zero so GitHub sends the configured workflow failure notification.

Cloudflare documents that `DELETE FROM` creates a new Iceberg snapshot rather than immediately removing the old files. The runner therefore performs one shared, row-filtered Iceberg rewrite and snapshot-expiration pass for each bounded group, then reports each verified result. It never asks Iceberg to compact an entire analytics table. Automatic Catalog maintenance remains useful backup maintenance, but it is not the deletion receipt.

Official references:

- [Cloudflare Pipelines](https://developers.cloudflare.com/pipelines/)
- [Structured stream behavior](https://developers.cloudflare.com/pipelines/streams/manage-streams/)
- [R2 Data Catalog sink](https://developers.cloudflare.com/pipelines/sinks/available-sinks/r2-data-catalog/)
- [R2 token permission groups](https://developers.cloudflare.com/r2/api/tokens/)
- [R2 Data Catalog maintenance credentials](https://developers.cloudflare.com/r2/data-catalog/manage-catalogs/)
- [Deleting Data Catalog data safely](https://developers.cloudflare.com/r2/data-catalog/deleting-data/)
- [Spark with R2 Data Catalog](https://developers.cloudflare.com/r2/data-catalog/config-examples/spark-python/)
- [Apache Iceberg 1.6.1 Spark procedures](https://iceberg.apache.org/docs/1.6.1/spark-procedures/)
