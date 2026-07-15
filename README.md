# Orange Replay

Orange Replay is session replay built natively on Cloudflare: compressed capture goes from the browser to a combined Worker, Durable Object, R2, D1, KV, and Queue pipeline. The shape keeps ops low, makes self-hosting practical, and has live watch built in from the start.

## Positioning

- Zero-decompression ingest: the server stores compressed payloads and does not inflate them on the hot path.
- Hibernating Durable Object pipeline: one session maps to one Durable Object, with batched writes and no always-on server.
- Live by default: the same session Durable Object is also the WebSocket hub for active viewers.
- Residency honest: payloads stay in Durable Objects and R2; D1, KV, and Queues carry scrubbed sidecar metadata.
- Privacy tiers: standard, strict, and future end-to-end modes make data inspection an explicit choice.

## Quickstart

```sh
git clone <repo-url>
cd orange-replay
export PATH="$HOME/.vite-plus/bin:$PATH"
vp install

vp run dev
```

This builds the local website assets, then starts the combined Worker on
`http://localhost:8787` and the dashboard development server on
`http://localhost:5200`. Use port `8787` to test the real landing page and its
public `/demo` workspace together. Port `5200` keeps dashboard hot reload for
normal dashboard work. Set `CLEAR_DEV_PORTS=1` only when you want the dev script
to stop existing listeners on those ports first. It uses `apps/worker/.env`
when present, otherwise it uses `apps/worker/.env.example`.

To run the dashboard only:

```sh
export PATH="$HOME/.vite-plus/bin:$PATH"
cd apps/dashboard
vp dev --port 5200
```

For the demo site:

```sh
export PATH="$HOME/.vite-plus/bin:$PATH"
cd fixtures/demo-site
vp dev
```

Private dashboard routes use Better Auth with GitHub in every environment. Copy `apps/worker/.env.example` to the ignored `apps/worker/.env`, create a local GitHub OAuth App, then uncomment and fill the five auth values before signing in. A missing or partial setup fails closed; the anonymous `/demo` remains available. Follow [Hosted accounts and project keys](./docs/hosted-auth.md) for the exact callback and local setup.

## Repo Map

| Path                  | What it is                                                                         |
| --------------------- | ---------------------------------------------------------------------------------- |
| `apps/worker`         | Canonical combined Worker: ingest, API, Durable Objects, queue consumer, and cron. |
| `apps/dashboard`      | Local dashboard for sessions, live watch, settings, and install.                   |
| `packages/shared`     | Shared wire formats, schemas, ids, constants, and logging helpers.                 |
| `packages/sdk`        | Browser recorder SDK and loader snippet builder.                                   |
| `packages/player`     | Replay loader, decoder, timeline, and live follow player.                          |
| `packages/rrweb-fork` | In-repo rrweb capture-side fork.                                                   |
| `fixtures`            | Demo site and browser e2e fixture.                                                 |
| `infra/template`      | Generated self-host template mirror.                                               |
| `docs`                | Design, install, self-host, and task specs.                                        |

## Docs

- [Architecture](./ARCHITECTURE.md)
- [Plan](./PLAN.md)
- [Handoff](./HANDOFF.md)
- [Production deployment](./docs/deployment.md)
- [Hosted accounts and project keys](./docs/hosted-auth.md)
- [Self-host guide](./docs/self-host.md)
- [SDK install guide](./docs/install-sdk.md)
- [Design language](./docs/design-language.md)

## Status

The local-first product is complete. Production deployment uses Cloudflare Workers with a separate production Wrangler config. Hosted accounts use GitHub OAuth through Better Auth while the demo stays public. Deferred: Analytics Engine verification, Pipelines/Iceberg lake, Vectorize/AI, heatmaps backend, processing lane, end-to-end encryption tier, BYOC provisioner, template publishing, and OSS license choice.

License: not yet chosen.
