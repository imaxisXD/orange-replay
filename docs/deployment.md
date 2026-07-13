# Production Deployment

Orange Replay has two environments only:

- **Dev**: `vp run dev`, local storage, and `apps/worker/.env`. The Worker serves
  the landing page and integrated `/demo` on port `8787`; the dashboard hot-reload
  server remains on port `5200`.
- **Prod**: real Cloudflare resources in the `production` Wrangler environment.

There is no staging environment.

## 1. Create Production Resources

Run these from the repo root after `vp install`:

```sh
export PATH="$HOME/.vite-plus/bin:$PATH"

vp exec --filter @orange-replay/worker -- wrangler d1 create orange-replay-idx-00-prod
vp exec --filter @orange-replay/worker -- wrangler r2 bucket create orange-replay-recordings-prod
vp exec --filter @orange-replay/worker -- wrangler kv namespace create CONFIG
vp exec --filter @orange-replay/worker -- wrangler queues create or-session-finalized-prod
vp exec --filter @orange-replay/worker -- wrangler queues create or-dlq-prod
```

Put the printed D1 `database_id` and KV `id` into a private deployment copy, or provide them as Cloudflare Workers Builds variables when deploying from GitHub. Keep the committed `INGEST_LOOKUP_RATE_LIMITER`, `INGEST_PROJECT_RATE_LIMITER`, and `INGEST_SESSION_RATE_LIMITER` bindings enabled; they protect public ingest before D1 lookups and Durable Object writes.

The committed file uses placeholder IDs. Keep real production IDs, tokens, and generated keys out of public commits. Use a private branch, local patch, or deployment-specific copy when wiring a public repo to your own Cloudflare account.

## 2. Apply D1 Migrations

```sh
vp exec --filter @orange-replay/worker -- wrangler d1 migrations apply IDX_00 \
  --env production \
  --remote
```

## 3. Prepare Dashboard API Secrets

```sh
export ORANGE_REPLAY_PROD_API_TOKEN="$(openssl rand -base64 32)"
export ORANGE_REPLAY_PROD_API_PROJECT_IDS="project_demo"
export ORANGE_REPLAY_PROD_LIVE_TICKET_SECRET="$(openssl rand -base64 32)"
export ORANGE_REPLAY_PROD_WORKER_URL="https://replay.example.com"
```

Use long random secrets, at least 32 characters. `ORANGE_REPLAY_PROD_API_PROJECT_IDS` is a comma-separated allowlist for the projects that token may access. The deploy script validates those values and uploads `DEV_API_TOKEN`, `DEV_API_PROJECT_IDS`, and `LIVE_TICKET_SECRET` as Worker secrets before deploy.

The dashboard build uses the first `ORANGE_REPLAY_PROD_API_PROJECT_IDS` value as its default project route. Set `VITE_DEFAULT_PROJECT_ID` before the chosen production deploy command only if you need the dashboard to open a different allowed project first. The value must also be listed in `ORANGE_REPLAY_PROD_API_PROJECT_IDS`.

Generated production values are stored locally in `apps/worker/.env.production`. That file is ignored by git.

Do not put production tokens, live ticket secrets, SDK write keys, or Cloudflare API tokens in `wrangler.jsonc`, package scripts, build commands, docs, or dashboard source. The production deploy commands validate and upload the production dashboard and analytics secrets before deploying, then call protected API routes with the same dashboard token. The SDK write key is kept only in the ignored local env file.

The SDK write key is still public once it is installed on a website. Treat it like a project-scoped browser credential, not like the dashboard bearer token. Exact allowed origins are a browser/CORS guard only; keep the committed ingest rate limiters, quota state, payload caps, and session caps enabled because non-browser clients can set any Origin header. Sampling is an honest-client optimization, not an abuse control.

## 4. Create The First Project And Write Key

```sh
node scripts/bootstrap-prod-project.mjs \
  --origin https://your-app.example
```

The script writes the first control-plane rows to D1, writes the matching KV cache entry, and saves the SDK write key to `apps/worker/.env.production` without printing it. It is insert-only and fails if the org, project, or key already exists. Use `--dry-run` first if you want to inspect the SQL and KV value; dry runs do not print or save the generated key.

By default, the script creates the first project id from `ORANGE_REPLAY_PROD_API_PROJECT_IDS`; without that environment value it uses `project_demo`. If you pass `--project-id` while `ORANGE_REPLAY_PROD_API_PROJECT_IDS` is set, the id must be in that allowlist. Use one or more exact `--origin https://...` values. The wildcard origin is accepted only through `--allow-any-origin`, which is for public test projects only.

## 5. Build And Deploy

```sh
vp run deploy:prod:d1
```

Use `deploy:prod:d1` for the first warehouse-enabled deploy. The analytics runbook has the reviewed `deploy:prod:compare`, `deploy:prod:r2-sql`, and `deploy:prod:rollback` commands. Do not use a D1 command after cutover unless you intend to roll back.

The command builds the browser SDK and dashboard, copies the public assets, generates a private production Wrangler config with the selected analytics backend, applies pending D1 migrations, uploads the required Worker secrets, and deploys with `--env production --keep-vars`. An `r2_sql` deploy first runs the full D1-to-R2 acceptance check and stops before deploy on any mismatch; D1 rollback skips that check. Keeping remote variables prevents an analytics cutover from removing existing production settings that are not repeated in the generated config. It then runs both the normal API smoke check and the metric-to-session analytics smoke check. Run the bootstrap step before the deploy so those checks have a real project to read.

Production route split:

| URL path             | Served by                           |
| -------------------- | ----------------------------------- |
| `/`                  | Static landing page from `landing/` |
| `/login`             | Dashboard app shell                 |
| `/projects/...`      | Dashboard app shell                 |
| `/or-recorder.js`    | Browser SDK bundle                  |
| `/api/*` and `/v1/*` | Worker API and ingest code          |

For a local deploy validation without uploading:

```sh
ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND=d1 vp run deploy:prod:dry-run
```

## 6. Cloudflare GitHub Auto Deploy

In Cloudflare Workers Builds, connect the GitHub repo to the `orange-replay` Worker.

Use these settings:

| Setting                      | Value                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Root directory               | `apps/worker`                                                                 |
| Build command                | `cd ../.. && pnpm install --frozen-lockfile && pnpm exec vp run build:deploy` |
| Deploy command               | `cd ../.. && pnpm exec vp run deploy:cloudflare-build`                        |
| Production branch            | `main`                                                                        |
| Non-production branch builds | Disabled                                                                      |

Add these Workers Builds variables before the first GitHub build:

| Variable                                    | Value                                                 |
| ------------------------------------------- | ----------------------------------------------------- |
| `ORANGE_REPLAY_PROD_KV_ID`                  | Production `CONFIG` KV namespace id                   |
| `ORANGE_REPLAY_PROD_D1_ID`                  | Production `orange-replay-idx-00-prod` D1 database id |
| `CLOUDFLARE_ACCOUNT_ID`                     | Production Cloudflare account id                      |
| `ORANGE_REPLAY_PROD_ANALYTICS_STREAM_ID`    | Production typed Pipeline stream id                   |
| `ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND` | Explicit `d1`, `compare`, or `r2_sql` choice          |
| `ORANGE_REPLAY_PROD_API_PROJECT_IDS`        | Comma-separated project ids, for example `p1`         |
| `ORANGE_REPLAY_PROD_WORKER_URL`             | Exact production Worker HTTPS origin                  |

The deploy command generates an ignored `apps/worker/wrangler.cloudflare-build.jsonc` file inside the build machine. The generated file contains deployment resource IDs and the explicit read backend, not tokens. Store `ORANGE_REPLAY_PROD_API_TOKEN` as a protected Workers Builds secret so the post-deploy smoke checks can authenticate. For an `r2_sql` build, also store `ORANGE_REPLAY_PROD_R2_SQL_TOKEN` as a protected build secret for the pre-deploy acceptance check. Runtime Worker secrets must already include `DEV_API_TOKEN`, `DEV_API_PROJECT_IDS`, `LIVE_TICKET_SECRET`, `R2_SQL_TOKEN`, and `ANALYTICS_PURGE_RUNNER_TOKEN`; the build checks their uploaded names before deploy.

## 7. SDK Snippet Values

Use one SDK package for both dev and prod. Only the values change. Production keeps `workers.dev` enabled until a custom domain is attached.

- Dev `ingestUrl`: `http://localhost:8787`
- Prod `ingestUrl`: your Worker URL or custom domain
- Dev key: local seed key
- Prod key: `ORANGE_REPLAY_PROD_WRITE_KEY` from `apps/worker/.env.production`
