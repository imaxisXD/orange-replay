# Self-host Orange Replay

This guide is for running the canonical combined Worker from this repo in your own Cloudflare account. It is manual today: no real resources are created by this repo, and the Deploy button is deferred until the public template repo is published.

## What You Get

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
- Wrangler installed and logged in:

```sh
wrangler login
```

- The self-host template generated locally:

```sh
node scripts/mirror-template.mjs
```

The local `infra/template` config points back to `apps/worker`, which is the canonical Worker source in this monorepo. The later public template repo will be the standalone copy.

## 1. Create Resources

Run these from `infra/template`:

```sh
cd infra/template

wrangler d1 create orange-replay-idx-00
wrangler r2 bucket create orange-replay-recordings
wrangler kv namespace create CONFIG
wrangler queues create or-session-finalized
wrangler queues create or-dlq
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

Durable Object classes are declared in `wrangler.jsonc`; Wrangler creates their namespaces during deploy.

## 2. Fill Placeholder IDs

Open `infra/template/wrangler.jsonc`.

- Replace `REPLACE_WITH_D1_ID` with the `database_id` printed by `wrangler d1 create`.
- Replace `REPLACE_WITH_KV_ID` with the `id` printed by `wrangler kv namespace create CONFIG`.

R2 buckets, queues, and rate-limit bindings use the names and namespace IDs in the template directly, so there is no id to paste for them.

## 3. Apply D1 Migrations

From `infra/template`:

```sh
wrangler d1 migrations apply orange-replay-idx-00
```

The mirror script copies `apps/worker/migrations` into `infra/template/migrations` verbatim.

## 4. Set The API Token Secrets

Self-host v1 uses a bearer token scoped to explicit project ids:

```sh
wrangler secret put DEV_API_TOKEN
wrangler secret put DEV_API_PROJECT_IDS
wrangler secret put LIVE_TICKET_SECRET
```

Use long random values, at least 32 characters, for `DEV_API_TOKEN` and `LIVE_TICKET_SECRET`. `DEV_API_PROJECT_IDS` is a comma-separated list, for example `project_demo`. Do not put any of these values in `wrangler.jsonc`.

For real self-host use, put Cloudflare Access in front of the dashboard and API routes. The project-scoped token is the v1 app-level check; Cloudflare Access gives you the account login and SSO layer.

When building the dashboard outside the production deploy script, set `VITE_DEFAULT_PROJECT_ID` to one of the ids in `DEV_API_PROJECT_IDS`. The dashboard uses it only for the first route and login token check.

## 5. Build The Dashboard Assets

The self-host Worker serves the dashboard and player through its `ASSETS` binding. Build those files from the repo root before deploying:

```sh
VITE_DEFAULT_PROJECT_ID=project_demo node scripts/build-deploy.mjs --production
```

Replace `project_demo` with one of the project ids in `DEV_API_PROJECT_IDS`. Re-run this command after pulling dashboard or player changes.

## 6. Deploy

From `infra/template`:

```sh
wrangler deploy
```

For playback caching, use a custom domain. Workers served only on `workers.dev` still play sessions, but Cache API is a no-op there, so repeated playback is uncached.

## 7. Connect The SDK

Use the install guide: [Install the SDK](./install-sdk.md).

Set `ingestUrl` to your deployed Worker URL or custom domain. Set `key` to the write key for the project you created in the Worker data.

## Upgrade

When `apps/worker/wrangler.jsonc` or `apps/worker/migrations` changes:

```sh
node scripts/mirror-template.mjs
node scripts/mirror-template.mjs --check
VITE_DEFAULT_PROJECT_ID=project_demo node scripts/build-deploy.mjs --production
cd infra/template
wrangler d1 migrations apply orange-replay-idx-00
wrangler deploy
```

Use the same project id that you stored in `DEV_API_PROJECT_IDS`.

If you need a stamped manifest for release automation, pass the stamp explicitly:

```sh
node scripts/mirror-template.mjs --stamp 2026-07-04T00:00:00.000Z
```
