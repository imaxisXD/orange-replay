# Sentry error monitoring

Orange Replay uses Sentry for first-party app errors and sampled performance traces. It covers:

- dashboard browser errors, React 19 root errors, TanStack Router errors, and route traces;
- public replay-page browser and hydration errors;
- combined Worker fetch, queue, and scheduled-handler errors;
- `SessionRecorder` and `PresenceRegistry` Durable Object fetch, alarm, and WebSocket errors.

It does not add Sentry to the customer recorder SDK. It also does not enable Sentry Session Replay or Sentry logs. Cloudflare wide events remain the source for normal operational facts.

## Privacy boundary

The shared filter removes request and response bodies, headers, cookies, query values, user details, project/session/public-page IDs, database values, local stack variables, and AI inputs or outputs. The Worker also replaces Sentry's default request-body integration with `maxRequestBodySize: "none"`, so ingest bodies are never copied for monitoring. This preserves the rule that the server does not inspect replay payloads.

Errors are sampled at 100%. Traces default to 5% in the dashboard, 2% on public pages, and 2% in the Worker. Set any trace rate to a number from `0` through `1` to change it.

## Sentry project setup

Create one JavaScript project in Sentry and use its DSN for both browser and Worker events. The `surface` tag separates `dashboard`, `public-page`, and `worker` events.

Local Worker values belong in the ignored `apps/worker/.env` file:

```dotenv
SENTRY_DSN=https://public-key@your-sentry-host/project-id
SENTRY_ENVIRONMENT=development
SENTRY_TRACES_SAMPLE_RATE=1
```

Set browser values in the shell before `vp run dev`, or in an ignored `apps/dashboard/.env.local` file:

```dotenv
VITE_SENTRY_DSN=https://public-key@your-sentry-host/project-id
VITE_SENTRY_ENVIRONMENT=development
VITE_SENTRY_TRACES_SAMPLE_RATE=1
```

For production:

1. Add `SENTRY_DSN` as a Worker secret. It is optional, so an existing deploy remains valid until the Sentry project is ready.
2. Add `VITE_SENTRY_DSN`, `VITE_SENTRY_ENVIRONMENT=production`, and the chosen browser trace rate to Workers Builds.
3. Add `SENTRY_AUTH_TOKEN` as a protected build secret, plus `SENTRY_ORG` and `SENTRY_PROJECT` as build variables. When all three exist, both Vite builds create hidden source maps, upload them to Sentry, then delete the local map files.
4. Keep `upload_source_maps: true` in Wrangler so Worker builds generate and upload their maps. Follow Sentry's Cloudflare source-map wizard once for the project if Sentry does not show readable Worker frames.

The browser DSN is designed to be public. The Sentry auth token is not; never put it in a `VITE_` variable, Wrangler config, source file, or committed environment file.

## Test the error cycle

Automated tests boot the real local Worker, send a guarded test error to a local Sentry-compatible envelope collector, and assert that the event arrives without its query, authorization, or cookie secrets.

For a real Sentry account, enable the local settings above, reuse the existing repo dev server if it is already running, and request:

```sh
curl -i http://localhost:8787/__test/sentry-error?customer-token=must-not-appear
```

The route exists only when `DEV_TEST_ROUTES=1` and `WORKER_ENV` is `development`, `test`, or `local`. Production always rejects the test route. In Sentry, verify:

- the issue is named `Orange Replay Sentry test error.`;
- the environment and `surface=worker` tag are correct;
- the URL has no query value and no request headers or cookies;
- the stack points to `apps/worker/src/observability/entry.ts` after source maps are configured.

Delete or resolve the test issue after the check. Do not test by throwing from a production customer route.

## AI agent debugging loop

Sentry has two useful AI paths:

1. Connect a coding agent to Sentry's remote MCP service at `https://mcp.sentry.dev/mcp`. OAuth is the preferred setup. Scope access to the Orange Replay organization and project, then give the agent a Sentry issue URL or ID. The agent can inspect the issue, events, traces, release, and related files before proposing a fix.
2. Enable Sentry Seer and its GitHub integration if you want Sentry's own agent to find a likely root cause and prepare a code change.

The safe loop is: inspect the issue, reproduce it, change the smallest owning surface, run focused tests, run `vp check` and `vp test`, deploy through the normal reviewed path, then confirm a new production event no longer occurs before resolving the issue. An AI suggestion is evidence to review, not permission to deploy or close an issue.

Orange Replay does not currently run an AI agent in production. If a Cloudflare Agent is added later, wrap its exported class with `instrumentAgentWithSentry`. Keep generative-AI inputs and outputs disabled unless a separate privacy review explicitly approves them.

Official references: [Sentry Cloudflare SDK](https://docs.sentry.io/platforms/javascript/guides/cloudflare/), [Sentry source maps for Cloudflare](https://docs.sentry.dev/platforms/javascript/guides/cloudflare/sourcemaps/), [Sentry MCP](https://github.com/getsentry/sentry-mcp), and [Sentry Seer](https://docs.sentry.io/product/ai-in-sentry/seer/).
