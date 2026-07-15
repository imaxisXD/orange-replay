# Production Deployment

Orange Replay has two environments only:

- **Dev**: `vp run dev`, local storage, and `apps/worker/.env`. The Worker serves
  the landing page and integrated `/demo` on port `8787`; the dashboard hot-reload
  server remains on port `5200`.
- **Prod**: real Cloudflare resources in the `production` Wrangler environment.

There is no staging environment. Run these commands from the repo root after `vp install`.

## 1. Create Production Resources And Config

```sh
export PATH="$HOME/.vite-plus/bin:$PATH"

vp exec --filter @orange-replay/worker -- wrangler d1 create orange-replay-idx-00-prod
vp exec --filter @orange-replay/worker -- wrangler r2 bucket create orange-replay-recordings-prod
vp exec --filter @orange-replay/worker -- wrangler kv namespace create CONFIG
vp exec --filter @orange-replay/worker -- wrangler queues create or-session-finalized-prod
vp exec --filter @orange-replay/worker -- wrangler queues create or-dlq-prod
```

Copy the printed D1 and KV ids into the current shell. Set the exact public Worker origin too. Use the real `workers.dev` origin until the custom domain is attached.

```sh
export ORANGE_REPLAY_PROD_D1_ID="your-production-d1-id"
export ORANGE_REPLAY_PROD_KV_ID="your-production-kv-id"
export ORANGE_REPLAY_PROD_WORKER_URL="https://replay.example.com"
export ORANGE_REPLAY_PROD_PUBLIC_PAGE_ORIGIN="https://public.replay.example.com"

node scripts/prepare-cloudflare-build-config.mjs
```

This creates the ignored `apps/worker/wrangler.cloudflare-build.jsonc` file with the real resource ids and public-page hostname. The committed config keeps placeholders so public commits never carry account-specific ids. Keep the rate-limit bindings in that generated config enabled.

The public-page hostname must be in an active Cloudflare zone. Remove any conflicting CNAME for that exact hostname before deploying. The deploy attaches it as a Worker Custom Domain, so Cloudflare creates its DNS record and certificate. No second Worker or static publication job is needed.

The analytics warehouse setup uses two different writer tokens. The bucket-scoped `ORANGE_REPLAY_CATALOG_TOKEN` is for catalog maintenance and the protected purge workflow. Cloudflare currently requires a separate account-wide `ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN` when creating a missing Pipeline Data Catalog sink. Cloudflare then saves that credential in the sink, so it must stay valid while the sink runs even though setup does not need it again. Keep the broader token in a local secret store and never add it to the Worker, GitHub Actions, or Workers Builds. See `docs/runbooks/r2-analytics.md` for the exact permissions, setup command, expiry check, and rotation path.

## 2. Apply D1 Migrations

```sh
node scripts/apply-d1-migrations.mjs orange-replay-idx-00-prod \
  --config apps/worker/wrangler.cloudflare-build.jsonc \
  --env production \
  --remote
```

Use this repo script instead of calling Wrangler migrations directly. It checks older Orange Replay databases before applying a migration. The deploy commands run it again safely, but a fresh install needs the schema now so the public demo can be created before the first deploy.

## 3. Create The GitHub OAuth App

Create a GitHub OAuth App for production. Use the same exact public origin for the homepage and Better Auth.

```text
Homepage: https://replay.example.com
Callback: https://replay.example.com/api/auth/callback/github
```

GitHub OAuth Apps accept one callback URL, so use a different OAuth App for local development.

Use long random secrets, at least 32 characters. Before its first build or Cloudflare change, the deploy script validates the complete Better Auth configuration and requires `ORANGE_REPLAY_PROD_WORKER_URL` to be one clean HTTPS origin without a path, query, or login. `ORANGE_REPLAY_PROD_PROJECT_ID` names the project used by the pre-deploy analytics acceptance gate; it is not a dashboard credential or route default.

Generated production values are stored locally in `apps/worker/.env.production`. That file is ignored by git.

Do not put production tokens, auth secrets, live ticket secrets, SDK write keys, or Cloudflare API tokens in `wrangler.jsonc`, package scripts, build commands, docs, or dashboard source. Normal production deploy commands validate the complete secret set first, then upload it with the reviewed Worker version only after the analytics gate passes. Cloudflare account authentication is removed from config generation, application builds, and smoke checks; only the D1, gate, Worker upload, deploy, and secret-name check steps receive it. The emergency D1 rollback reuses a prepared Worker version and its versioned secrets. The SDK write key is kept only in the ignored local env file.

The SDK write key is still public once it is installed on a website. Treat it like a project-scoped browser credential, not like a dashboard account credential. Exact allowed origins are a browser/CORS guard only; keep the committed ingest rate limiters, quota state, payload caps, and session caps enabled because non-browser clients can set any Origin header. Sampling is an honest-client optimization, not an abuse control.

## 4. Prepare Hosted Auth Values

```sh
export ORANGE_REPLAY_PROD_BETTER_AUTH_URL="$ORANGE_REPLAY_PROD_WORKER_URL"
export ORANGE_REPLAY_PROD_BETTER_AUTH_TRUSTED_ORIGINS="$ORANGE_REPLAY_PROD_WORKER_URL"
export ORANGE_REPLAY_PROD_BETTER_AUTH_SECRET="your-saved-better-auth-secret"
export ORANGE_REPLAY_PROD_GITHUB_CLIENT_ID="your-github-client-id"
export ORANGE_REPLAY_PROD_GITHUB_CLIENT_SECRET="your-github-client-secret"
export ORANGE_REPLAY_PROD_PROJECT_ID="your-analytics-gate-project-id"
export ORANGE_REPLAY_PROD_LIVE_TICKET_SECRET="your-saved-live-ticket-secret"
export ORANGE_REPLAY_PROD_R2_SQL_TOKEN="your-read-only-r2-sql-token"
export ORANGE_REPLAY_PROD_ANALYTICS_PURGE_RUNNER_TOKEN="your-saved-purge-runner-secret"
```

Generate the Better Auth, live-ticket, and purge-runner secrets once with `openssl rand -base64 48`, save them in a password manager, and reuse the same values on later deploys. Changing `BETTER_AUTH_SECRET` signs everyone out and can make stored encrypted OAuth tokens unreadable. The purge workflow and Worker must use the same purge-runner value.

Private dashboard and project APIs use Better Auth sessions only. The post-deploy analytics smoke check reads the anonymous demo API, so it does not need a private dashboard credential.

## 5. Create And Load The Public Demo

The anonymous demo uses its own project and write key. It is separate from every signed-in account.

For a fresh production database, inspect the insert first, then create it with the generated production config:

```sh
node scripts/bootstrap-demo-project.mjs \
  --config apps/worker/wrangler.cloudflare-build.jsonc \
  --origin "$ORANGE_REPLAY_PROD_WORKER_URL" \
  --dry-run

node scripts/bootstrap-demo-project.mjs \
  --config apps/worker/wrangler.cloudflare-build.jsonc \
  --origin "$ORANGE_REPLAY_PROD_WORKER_URL"
```

The second command writes the durable D1 rows and queues the KV cache fill for the Worker repair job. The key works through the D1 fallback while that cache is filled. It also saves `ORANGE_REPLAY_DEMO_PROJECT_ID` plus `ORANGE_REPLAY_DEMO_WRITE_KEY` in the ignored `apps/worker/.env.production` file without printing the write key. Load those two values into the current shell:

```sh
set -a
. apps/worker/.env.production
set +a
```

The bootstrap is insert-only. If the demo already exists, do not run it again. Load the original two demo values from the ignored file or password manager instead.

Before running either deploy path, check every local value:

```sh
node scripts/check-prod-secret.mjs --validate-only
```

This checks all ten hosted-auth, analytics, and public-demo values without contacting or changing Cloudflare.

## 6. Build And Deploy From This Machine

Keep the resource ids and all ten production secret values loaded in the same shell, then run:

```sh
vp run deploy:prod:d1
```

Use `deploy:prod:d1` for the first warehouse-enabled deploy. The analytics runbook has the reviewed `deploy:prod:compare`, `deploy:prod:r2-sql`, and `deploy:prod:rollback` commands. Do not use a D1 command after cutover unless you intend to roll back.

Normal D1, compare, and R2 SQL commands build the browser SDK and dashboard, copy the public assets, generate private selected-backend and D1-fallback Wrangler configs, and apply pending D1 migrations. Compare and R2 SQL both run the full D1-to-R2 acceptance check with the exact R2 SQL token that their Worker version will receive. Any mismatch stops before a Worker version or secret changes. After the check passes, Wrangler first uploads the same code, assets, and reviewed secrets as an inactive D1 version with a unique `orange-replay-d1-fallback-...` tag. It sends no traffic to that version. Wrangler then deploys the selected backend. Both uploads use `--strict --keep-vars`; private temporary secret files are added with `--secrets-file` and omitted remote secrets stay in place. Each command then runs the API and metric-to-session smoke checks. Run the bootstrap step before a normal deploy so those checks have a real project to read.

`vp run deploy:prod:rollback` is the emergency exception. It asks Cloudflare for the ten newest `orange-replay` versions, chooses the newest valid D1 fallback tag, and sends 100% of traffic to that exact version ID. The command names the Worker directly and runs Wrangler from the system temporary directory, so it does not read the current Worker source, dashboard assets, generated config, or normal release steps. It then runs the same two smoke checks. If no prepared tag is available, it stops without changing traffic.

`vp run deploy:prod:rollback:rebuild` is the explicit second choice. It creates a D1 config and deploys the current checkout with the already-built dashboard assets. Use it only when the tagged version is unavailable and after reviewing the current source and assets; missing or broken local files can block this path.

The public smoke check verifies health, GitHub auth mode, signed-out account denial, demo discovery, and the public login and demo pages. The analytics smoke check uses that anonymous demo to verify exact metric-to-session doorways. Neither check completes a real GitHub sign-in.

For a local build and Wrangler validation without a remote migration, secret upload, or deployment:

```sh
vp run deploy:prod:dry-run
```

Production route split:

| URL path             | Served by                           |
| -------------------- | ----------------------------------- |
| `/`                  | Static landing page from `landing/` |
| `/login`             | Dashboard app shell                 |
| `/projects/...`      | Dashboard app shell                 |
| `/_admin/...`        | Operator dashboard app shell        |
| `/p/:publicId`       | Server-rendered public project page |
| `/public/*`          | Public page browser assets          |
| `/or-recorder.js`    | Browser SDK bundle                  |
| `/api/*` and `/v1/*` | Worker API and ingest code          |
| `/internal/*`        | Token-protected maintenance API     |

## 7. Link The First Account

Open `/login` and sign in with GitHub once. A new install creates a personal workspace and default project when the dashboard opens. Create the first named project key from Settings; its plaintext is shown only once.

If this database already has a workspace from before Better Auth, link it deliberately. The script refuses to guess or replace another owner:

```sh
vp run workspace:link-owner -- \
  --config apps/worker/wrangler.cloudflare-build.jsonc \
  --email you@example.com \
  --workspace-id YOUR_WORKSPACE_ID \
  --remote
```

Promote the known operator account before using `/_admin`:

```sh
vp run auth:promote-admin -- \
  --config apps/worker/wrangler.cloudflare-build.jsonc \
  --email you@example.com \
  --remote
```

Test one real production GitHub sign-in and one key create/revoke flow. Only after that private canary passes, remove the two retired shared-token Worker secrets:

```sh
vp run auth:retire-shared-token-secrets \
  --config apps/worker/wrangler.cloudflare-build.jsonc
```

The command requires the explicit login-confirmation flag built into the package script, verifies every Better Auth-era Worker secret is present, removes only `DEV_API_TOKEN` and `DEV_API_PROJECT_IDS`, then verifies the required secrets remain and the retired names are gone. Do not roll back to a Worker version that still depends on shared-token auth after this step; use the tagged D1 fallback produced by the Better Auth-only deploy.

Optionally add Cloudflare Access around `/_admin*` as a second gate; the Worker still checks the Better Auth admin role on every operator API.

## 8. Cloudflare GitHub Auto Deploy

Complete sections 1 through 5 once before the first automatic build. The demo needs its D1 rows before the post-deploy smoke check can pass; the Worker fills its KV cache safely.

Run one reviewed machine deploy before connecting the build. That path validates and uploads all ten runtime secrets only after the analytics gate passes. The automatic build then checks their names and preserves their existing values.

In Cloudflare Workers Builds, connect the GitHub repo to the `orange-replay` Worker and use these settings:

| Setting                      | Value                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Root directory               | `apps/worker`                                                                 |
| Build command                | `cd ../.. && pnpm install --frozen-lockfile && pnpm exec vp run build:deploy` |
| Deploy command               | `cd ../.. && pnpm exec vp run deploy:cloudflare-build`                        |
| Production branch            | `main`                                                                        |
| Non-production branch builds | Disabled                                                                      |

Add these Workers Builds variables before the first build:

| Variable                                             | Value                                                 |
| ---------------------------------------------------- | ----------------------------------------------------- |
| `ORANGE_REPLAY_PROD_KV_ID`                           | Production `CONFIG` KV namespace id                   |
| `ORANGE_REPLAY_PROD_D1_ID`                           | Production `orange-replay-idx-00-prod` D1 database id |
| `CLOUDFLARE_ACCOUNT_ID`                              | Production Cloudflare account id                      |
| `ORANGE_REPLAY_PROD_ANALYTICS_STREAM_ID`             | Production typed Pipeline stream id                   |
| `ORANGE_REPLAY_PROD_ANALYTICS_DELETION_V2_STREAM_ID` | Versioned deletion Pipeline stream id                 |
| `ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND`          | Explicit `d1`, `compare`, or `r2_sql` choice          |
| `ORANGE_REPLAY_PROD_ANALYTICS_DELETION_READ_VERSION` | Keep `v1` until the v2 backfill is ready              |
| `ORANGE_REPLAY_PROD_PROJECT_ID`                      | Project id used by the analytics acceptance gate      |
| `ORANGE_REPLAY_PROD_WORKER_URL`                      | Exact public Worker origin used by the smoke checks   |
| `ORANGE_REPLAY_PROD_PUBLIC_PAGE_ORIGIN`              | Exact HTTPS origin used for public project pages      |

The deploy command generates ignored selected-backend and D1-fallback Wrangler files inside the build machine. It checks that all ten secret names already exist before it changes the database, then applies migrations, runs the analytics gate, deploys, and runs both smoke checks. Keep `ORANGE_REPLAY_PROD_ANALYTICS_DELETION_READ_VERSION=v1` until the v2 deletion table is provisioned and D1 reports every retained tombstone as visible; only then use `v2`. For `compare` and `r2_sql`, store `ORANGE_REPLAY_PROD_R2_SQL_TOKEN` as a protected build secret; the gate and deployed Worker use the exact same reader token. The Worker must already have these runtime secret names:

| Worker secret                  | Value loaded locally from                         |
| ------------------------------ | ------------------------------------------------- |
| `BETTER_AUTH_SECRET`           | `ORANGE_REPLAY_PROD_BETTER_AUTH_SECRET`           |
| `BETTER_AUTH_URL`              | `ORANGE_REPLAY_PROD_BETTER_AUTH_URL`              |
| `BETTER_AUTH_TRUSTED_ORIGINS`  | `ORANGE_REPLAY_PROD_BETTER_AUTH_TRUSTED_ORIGINS`  |
| `GITHUB_CLIENT_ID`             | `ORANGE_REPLAY_PROD_GITHUB_CLIENT_ID`             |
| `GITHUB_CLIENT_SECRET`         | `ORANGE_REPLAY_PROD_GITHUB_CLIENT_SECRET`         |
| `LIVE_TICKET_SECRET`           | `ORANGE_REPLAY_PROD_LIVE_TICKET_SECRET`           |
| `DEMO_PROJECT_ID`              | `ORANGE_REPLAY_DEMO_PROJECT_ID`                   |
| `DEMO_WRITE_KEY`               | `ORANGE_REPLAY_DEMO_WRITE_KEY`                    |
| `R2_SQL_TOKEN`                 | `ORANGE_REPLAY_PROD_R2_SQL_TOKEN`                 |
| `ANALYTICS_PURGE_RUNNER_TOKEN` | `ORANGE_REPLAY_PROD_ANALYTICS_PURGE_RUNNER_TOKEN` |

The automatic deploy runs a read-only `wrangler secret list` check and stops before migration when a name is missing. Wrangler cannot show secret values. The public smoke catches a missing auth configuration and signed-out routing failures, but it cannot prove that GitHub OAuth credentials or callbacks work; complete the real login canary and explicit retirement step in section 7. The `secrets.required` list in the Wrangler config also keeps generated types and local-development warnings in sync.

The physical-deletion workflow needs the same `ANALYTICS_PURGE_RUNNER_TOKEN` as a GitHub Actions secret. It also needs the catalog writer token as `ORANGE_REPLAY_CATALOG_TOKEN`; never upload that catalog writer token to the Worker. Follow the exact variables and verification steps in [R2 analytics warehouse runbook](./runbooks/r2-analytics.md#physical-deletion-within-24-hours).

## 9. SDK Snippet Values

Use one SDK package for both dev and prod. Only the values change. Production keeps `workers.dev` enabled until a custom domain is attached.

- Dev `ingestUrl`: `http://localhost:8787`
- Prod `ingestUrl`: your Worker URL or custom domain
- Dev key: local seed key
- Prod key: a named project key created in Settings and saved when it is shown once

The SDK write key is public once it is installed on a website. Treat it as a project-scoped browser credential, not a dashboard login secret. Exact allowed origins are a browser and CORS guard only. Keep the rate limits, quota state, payload caps, and session caps enabled because a non-browser client can set any `Origin` header.
