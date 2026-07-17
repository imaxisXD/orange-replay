# Dashboard request policy owner

Status: complete (2026-07-17).

## Goal

Put every pathname-and-method-derived dashboard API decision behind one pure matcher. Keep the
request handler and authentication module as adapters that execute the matched policy.

This is a behavior-preserving refactor. It adds no route, response field, dependency, migration,
binding, storage read, or storage write.

## Owner

`apps/worker/src/api/dashboard-request-policy.ts` is the single owner of:

- route matching and the wide-event route name;
- allowed methods and handler actions;
- public, Better Auth, live-ticket, or dashboard authentication mode;
- session, global-admin, or project access requirements;
- the exact demo-readable and minimum-project-role matrix;
- path value extraction and pure id or segment-name validation results;
- routes that require session authentication rather than demo authentication;
- trusted-origin requirements for mutations;
- public-page and analytics-read rate-limit selection;
- Better Auth security headers and authenticated-project response wrapping.

The matcher receives only `method` and `pathname`. It performs no I/O and does not read Worker
bindings, request headers, cookies, tickets, storage, or auth state.

## Adapters

`apps/worker/src/api/handler.ts` executes one matched policy for the request. It retains:

- request-id creation and one final wide event;
- authentication, rate-limit, origin, and domain-handler calls;
- status and error mapping;
- response-header application.

`apps/worker/src/api/auth.ts` retains credential verification and project-membership checks. It
reads the route access rule from the policy owner instead of keeping a second demo/role matrix.

## Locked precedence

The top-level order remains:

1. `GET /api/v1/health`.
2. Every method under `/api/auth` or `/api/auth/*`.
3. `GET /api/v1/auth/config`.
4. `GET /api/v1/demo`.
5. Public-page GET routes.
6. Private live GET with a ticket.
7. Dashboard authentication for every remaining request.
8. Project/session/admin access, mutation origin, and domain handler dispatch.

The unusual ordering is intentional and must stay covered:

- A public-page limiter runs before public id, replay id, or segment-name rejection.
- Private live rejects an invalid project or session id before ticket verification.
- Normal private project routes authenticate before rejecting path ids.
- Project authorization runs before a private segment-name rejection.
- Project authorization runs before a mutation origin rejection.
- An explicit bad `Authorization` header fails before the demo limiter. Otherwise the demo limiter
  runs before a demo project mismatch or unknown dashboard route.
- The analytics-read limiter runs only for the session list and project stats, after authentication
  and project access.

## Method and path behavior

- Route log names depend on pathname shape, not method support.
- `HEAD` is not treated as `GET`.
- Exact path matching remains strict; trailing slashes do not match.
- An ordinary supported-shape path with an unsupported method authenticates as a dashboard request
  and then returns the existing not-found result. It does not perform route-specific id, project,
  session, origin, or analytics-rate checks.
- Project config is the deliberate exception: any method on its exact path validates and authorizes
  the project with read access. `GET` reads, `PUT` requires manager access and trusted origin, and
  every other method falls through to the existing not-found result.
- Broad `/api/v1/projects/:projectId` extraction remains available to authentication even when the
  remainder is unknown. Exact route values are used only after a route matches.

## Access policy

Demo access remains limited to sessions, session heads, session state, stats, project live,
manifests, live tickets, and segments. Config, install status, public-page settings, and project keys
remain unavailable in demo mode.

Hosted project members keep read access. Manager access remains required for config writes,
public-page settings, and key management. Key reads and mutations still require a hosted session,
so demo credentials cannot use them even if a future route rule is changed accidentally.

## Response and observability policy

- Better Auth responses retain the existing JSON security headers.
- Successful authenticated project-domain responses retain `Vary: Cookie` and private no-store
  behavior. Existing public cache directives are replaced with private directives for hosted
  session access. Demo responses remain unchanged.
- Early authentication, path, access, rate-limit, and origin errors are not passed through the
  authenticated-project response wrapper.
- The request id remains created by `handleApi`, before matching results are executed.
- The `api.request` wide event retains one pathname-based route name and the existing field timing.

## File budget

Exactly these five files are in scope:

- `apps/worker/src/api/dashboard-request-policy.ts`
- `apps/worker/src/api/handler.ts`
- `apps/worker/src/api/auth.ts`
- `apps/worker/tests/dashboard-request-policy.test.ts`
- `docs/specs/dashboard-request-policy-owner.md`

Do not change domain handlers, storage code, response types, dashboard code, public-page code,
Worker routing, deployment configuration, or dependencies.

## Required proof

1. A table test covers every supported path/method, action, log name, authentication mode, access
   rule, origin requirement, rate limit, and response policy.
2. Handler tests prove the unusual ordering listed above with mock call order or blocked downstream
   calls.
3. Method-independent log names, strict trailing-slash behavior, `HEAD`, ordinary method mismatch,
   the config exception, and broad project-id extraction are explicit tests.
4. The complete demo/role matrix has one owner and exact table coverage.
5. Domain 404 responses receive the authenticated-project cache wrapper while early and demo
   responses do not.
6. Existing hosted auth, demo auth, API helper, recording, live-ticket, public-page, sessions/stats,
   session-continuity, and account tests remain green.
7. Focused format, lint, type, test, and Worker build checks pass.

## Review map

- Input: dashboard, player, public replay, Better Auth, or live-ticket HTTP request.
- Storage: unchanged; domain handlers retain all D1, R2, KV, Durable Object, Queue, and analytics
  ownership.
- Backend: pure request classification followed by existing auth and domain adapters.
- API: existing paths, methods, statuses, errors, response fields, cache headers, and request ids are
  unchanged.
- User surfaces: dashboard API client and auth bootstrap, replay player manifest/segment/live calls,
  public replay page, and route-based operations logs.
- Visible result: no intended UI, text, loading, empty, error, or interaction change.
- Not affected: SDK, ingest, consumer, cron, migrations, billing, deployment, and SLA behavior.
