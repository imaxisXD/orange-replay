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

cp apps/worker/.dev.vars.example apps/worker/.dev.vars
cd apps/worker
wrangler d1 migrations apply orange-replay-idx-00 --local
wrangler dev
```

In a second terminal:

```sh
export PATH="$HOME/.vite-plus/bin:$PATH"
cd apps/dashboard
vp dev
```

In a third terminal for the demo site:

```sh
export PATH="$HOME/.vite-plus/bin:$PATH"
cd fixtures/demo-site
vp dev
```

The dashboard uses the dev bearer token from `apps/worker/.dev.vars.example`.

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
- [Self-host guide](./docs/self-host.md)
- [SDK install guide](./docs/install-sdk.md)
- [Design language](./docs/design-language.md)

## Status

Local-first v1 is in progress. Deferred: Analytics Engine verification, Pipelines/Iceberg lake, Vectorize/AI, heatmaps backend, processing lane, end-to-end encryption tier, BYOC provisioner, GitHub OAuth, template publishing, deploys, and OSS license choice.

License: not yet chosen.
