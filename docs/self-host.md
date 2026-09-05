# Self-host Orange Replay

This guide is for running the canonical combined Worker from this repo in your own Cloudflare account. Setup is manual; Wrangler creates the configured queues during deployment. The Deploy button is deferred until the public template repo is published.

## What you get

| Area                     | Status   |
| ------------------------ | -------- |
| Session replay           | Included |
| Live watch               | Included |
| Default input masking    | Included |
| Heatmaps                 | Deferred |
| AI search and summaries  | Deferred |
| BYOC managed provisioner | Deferred |

## Prerequisites

- A Cloudflare account.
- Node 22.18 or newer and the repo's pinned Wrangler **4.129.0**. Run these from the repo root so the later `wrangler` commands use that version:

```sh
vp install --frozen-lockfile
export PATH="$PWD/apps/worker/node_modules/.bin:$PATH"
wrangler --version
wrangler login
```

- The self-host template generated locally:

```sh
node scripts/mirror-template.mjs
```

The local `infra/template` config points back to `apps/worker`, which is the canonical Worker source in this monorepo. The later public template repo will be the standalone copy.

## 1. Create resources

Run these from `infra/template`:

```sh
cd infra/template

wrangler d1 create orange-replay-idx-00
wrangler r2 bucket create orange-replay-recordings
wrangler kv namespace create CONFIG
```

The template expects these bindings:

| Binding                       | Cloudflare resource | Name used by the template    |
| ----------------------------- | ------------------- | ---------------------------- |
| `IDX_00`                      | D1 database         | `orange-replay-idx-00`       |
| `RECORDINGS`                  | R2 bucket           | `orange-replay-recordings`   |
| `CONFIG`                      | KV namespace        | `CONFIG`                     |
| `INGEST_LOOKUP_RATE_LIMITER`  | Rate limit binding  | declared in `wrangler.jsonc` |
| `INGEST_PROJECT_RATE_LIMITER` | Rate limit binding  | declared in `wrangler.jsonc` |
| `INGEST_SESSION_RATE_LIMITER` | Rate limit binding  | declared in `wrangler.jsonc` |
| `FINALIZE_QUEUE`              | Queue producer      | `or-session-finalized`       |
| `or-session-finalized`        | Queue consumer      | `or-session-finalized`       |
| `or-dlq`                      | Dead-letter queue   | `or-dlq`                     |
| `REPLAY_ASSET_QUEUE`          | Queue producer      | `or-replay-assets`           |
| `or-replay-assets`            | Queue consumer      | `or-replay-assets`           |
| `or-replay-assets-dlq`        | Dead-letter queue   | `or-replay-assets-dlq`       |

Wrangler's [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) creates missing producer queues with these exact names and reuses existing queues. Deploying connects the consumers and creates missing dead-letter queues. Keep provisioning enabled and give your deployment token permission to create and update Queues. Consumer-only queues without matching producer bindings must already exist. If provisioning is disabled or an older Wrangler is used, create all four named queues with `wrangler queues create` before deploying.

Styling downloads use a separate queue so a slow website cannot hold up finalized recordings. Existing styling jobs in the old finalization queue are forwarded safely. If you rename the styling queue, update its producer, consumer, and `REPLAY_ASSET_QUEUE_NAME` together.

Durable Object classes are declared in `wrangler.jsonc`; Wrangler creates their namespaces during deploy.

## 2. Fill placeholder IDs

Open `infra/template/wrangler.jsonc`.

- Replace `REPLACE_WITH_D1_ID` with the `database_id` printed by `wrangler d1 create`.
- Replace `REPLACE_WITH_KV_ID` with the `id` printed by `wrangler kv namespace create CONFIG`.

R2 buckets, queues, and rate-limit bindings use the names and namespace IDs in the template directly, so there is no id to paste for them.

## 3. Apply D1 migrations

From `infra/template`:

```sh
wrangler d1 migrations apply orange-replay-idx-00
```

The mirror script copies `apps/worker/migrations` into `infra/template/migrations` verbatim.

## 4. Configure Better Auth and GitHub

Better Auth with GitHub is the only private dashboard sign-in path. Create a GitHub OAuth App for the exact public Worker origin you will deploy:

```text
Homepage: https://replay.example.com
Callback: https://replay.example.com/api/auth/callback/github
```

Then create the required Worker values from `infra/template`. Use your own exact origin in both URL values:

```sh
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put BETTER_AUTH_URL
wrangler secret put BETTER_AUTH_TRUSTED_ORIGINS
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put LIVE_TICKET_SECRET
wrangler secret put WEBSITE_KEY_WRAP_SECRET
```

Generate separate random values of at least 32 characters for `BETTER_AUTH_SECRET`, `LIVE_TICKET_SECRET`, and `WEBSITE_KEY_WRAP_SECRET`. The Website secret encrypts a newly created Website key only until that Website sends its first accepted event; changing it strands any setup that is still unfinished. Set `BETTER_AUTH_URL` to the exact public Worker origin. Set `BETTER_AUTH_TRUSTED_ORIGINS` to that same origin, or a comma-separated list of exact allowed origins. Do not put secret values in `wrangler.jsonc`.

A missing or partial Better Auth setup fails closed. It does not enable a shared-token fallback. Cloudflare Access can be added around `/_admin*` as an optional second gate, but the Worker still checks the Better Auth account and admin role itself.

## 5. Build the dashboard assets

The self-host Worker serves the dashboard and player through its `ASSETS` binding. Build those files from the repo root before deploying:

```sh
node scripts/build-deploy.mjs --production
```

Re-run this command after pulling dashboard or player changes.

## 6. Deploy

From `infra/template`:

```sh
wrangler deploy
```

Private replay segments use a five-minute private browser cache. Replay delivery does not currently use a shared Cache API entry, so this cache also works on `workers.dev`. Public replay responses keep their separate cache restrictions.

## 7. Connect the SDK

Use the install guide: [Install the SDK](./install-sdk.md).

Set `ingestUrl` to your deployed Worker URL or custom domain. Set `key` to the recorder key shown for that Website during onboarding.

## Upgrade

For the architecture recovery update, use the pinned Wrangler so deployment creates `or-replay-assets` and `or-replay-assets-dlq` if missing. Apply migrations `0028_session_finalization_jobs.sql` and `0029_analytics_export_retry.sql` before running the new Worker. Hosted production uses the corresponding `-prod` queue names in `apps/worker/wrangler.jsonc`.

Publish the compatible Worker and player before publishing the new SDK. The SDK sends masking evidence only when recorder config advertises `domMaskingVersion: 1`; older configs keep recording without that optional evidence. Keep the old finalization queue while existing styling messages drain through its forwarding path.

The new SQL is additive. A Worker rollback should keep the new tables, column, and queues so retained recovery work is not discarded. Do not delete recovery records or replay objects to clear a failed delivery. Check the finalization repair event, oldest pending recovery job, analytics delivery delay, and both dead-letter queues after an upgrade. Recordings already orphaned before this update need a separate inventory of their saved DO state, immutable manifests, and retained messages; this update does not claim to reconstruct missing receipts.

Apply only numbered files from `apps/worker/migrations` (or their mirrored copies). `apps/worker/drizzle/20260905050826_architecture_recovery_checkpoint` updates Drizzle's schema history for future generation; its combined historical SQL must not be applied separately.

When `apps/worker/wrangler.jsonc` or `apps/worker/migrations` changes:

```sh
node scripts/mirror-template.mjs
node scripts/mirror-template.mjs --check
node scripts/build-deploy.mjs --production
cd infra/template
wrangler d1 migrations apply orange-replay-idx-00
wrangler deploy
```

If you need a stamped manifest for release automation, pass the stamp explicitly:

```sh
node scripts/mirror-template.mjs --stamp 2026-07-04T00:00:00.000Z
```
