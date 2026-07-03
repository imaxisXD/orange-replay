# @orange-replay/worker

The canonical combined Worker: ingest routes + dashboard API + `SessionRecorder`
Durable Object + finalize-queue consumer + retention cron, in one deployable.
Design: `../../ARCHITECTURE.md`. Execution contract: `../../PLAN.md`.

## Local development

```sh
cp .dev.vars.example .dev.vars
vp install               # once, from the repo root
wrangler d1 migrations apply orange-replay-idx-00 --local
wrangler dev             # boots workerd with local R2/KV/D1/queue simulations
```

Seed a project + write key through the guarded test surface (requires
`DEV_TEST_ROUTES=1`):

```sh
curl -X POST http://localhost:8787/__test/ingest/seed \
  -H 'content-type: application/json' \
  -d '{"key":"or_dev_key","kv":true,"config":{"projectId":"p1","orgId":"o1","shard":0,"active":true,"sampleRate":1,"allowedOrigins":["*"],"maskPolicyVersion":1,"quotaState":"ok","retentionDays":30}}'
```

## Tests

`vp test` from the repo root. Integration tests boot the real worker via
wrangler `unstable_dev` against `/__test/*` routes (see `tests/harness.test.ts`
for the canonical pattern); DO lifecycle tests compress the idle windows with
the `TEST_TIMINGS` var. `src/` is workers-typed, `tests/` is node-typed — keep
the two type worlds separate.
