# @orange-replay/worker

The canonical combined Worker: ingest routes + dashboard API + `SessionRecorder`
Durable Object + finalize-queue consumer + retention cron, in one deployable.
Design: `../../ARCHITECTURE.md`. Execution contract: `../../PLAN.md`.

## Local development

```sh
cp .env.example .env
vp install # once, from the repo root
vp exec --filter @orange-replay/worker -- wrangler d1 migrations apply orange-replay-idx-00 --local
vp exec --filter @orange-replay/worker -- wrangler dev --port 8787
```

From the repo root, `vp run dev` starts both this Worker and the dashboard.
Private dashboard routes require a Better Auth session. Copy `.env.example` to
`.env`, add the GitHub OAuth values, and use the callback shown in that file.
Anonymous access is limited to the configured read-only `/demo` workspace.

Seed a project + write key through the guarded test surface (requires
`DEV_TEST_ROUTES=1`):

```sh
curl -X POST http://localhost:8787/__test/ingest/seed \
  -H 'content-type: application/json' \
  -d '{"key":"or_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kv":true,"config":{"projectId":"p1","orgId":"o1","shard":0,"active":true,"sampleRate":1,"allowedOrigins":["*"],"maskPolicyVersion":1,"quotaState":"ok","retentionDays":30}}'
```

## Tests

`vp test` from the repo root. Integration tests boot the real worker via
wrangler `unstable_dev` against `/__test/*` routes (see `tests/harness.test.ts`
for the canonical pattern); DO lifecycle tests compress the idle windows with
the `TEST_TIMINGS` var. `src/` is workers-typed, `tests/` is node-typed — keep
the two type worlds separate.
