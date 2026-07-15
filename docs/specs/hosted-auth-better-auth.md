# Hosted auth — Better Auth, workspaces, and project keys

Read `ARCHITECTURE.md` section 6 and the security rules in `PLAN.md`. This task adds the hosted SaaS account boundary without changing the public demo or the recording SDK write-key path.

## Product contract

- Hosted sign-in is GitHub OAuth through Better Auth. There is no password, magic-link, or Google sign-in flow.
- `/demo` and its existing read-only API allowlist stay public. A guest can view the demo without an account.
- A signed-in user owns a workspace membership. Projects belong to that workspace, and project write keys belong to a project.
- The dashboard session cookie is for people. The recorder keeps using a project write key; it never receives the person's session cookie.
- Better Auth is the only private dashboard sign-in path in hosted, self-hosted, and local installs. A missing or partial Better Auth configuration fails closed; it never falls back to a shared bearer token.
- The combined Worker remains the canonical deployment. The operator console is served at `/_admin`; a separate static Worker is not a security boundary.

## Better Auth setup

- Pin the Worker and dashboard to `better-auth@1.6.23`.
- Use the Worker `IDX_00` D1 binding directly. Do not add Drizzle just for Better Auth and do not run migrations during a request.
- Mount Better Auth below `/api/auth/*` before the current project API authorization.
- Enable only the GitHub social provider, the Organization plugin, and the Admin plugin.
- Use exact trusted origins, secure HTTP-only cookies in production, database-backed rate limits, `cf-connecting-ip`, and encrypted stored OAuth tokens.
- Keep Better Auth's library logging off. Orange Replay continues to emit one wide event for each HTTP request.
- Hosted mode is enabled only when the Better Auth URL, secret, and both GitHub values are valid. An incomplete hosted configuration fails closed.

## Data model and migration

Add immutable D1 migrations after the existing analytics and session-head migrations, and keep the test schema in sync.

- Better Auth core: `users`, `auth_sessions`, `auth_accounts`, `auth_verifications`, and `auth_rate_limits`.
- Reuse `orgs` as the Better Auth organization table by adding its slug and optional profile fields.
- Add `members` and `invitations`, with readable snake-case field names.
- Add stable ID, display name, creator, revoker, revocation time, durable cache-sync state, and a durable final-check time to `keys`. Track active KV writers in `key_cache_writes` before they can write. An unfinished writer moves to a later check time after each repair so it stays covered without blocking the rest of the repair queue. Existing keys are backfilled as legacy keys and all existing caches are queued for one safe refresh.
- Add useful indexes for membership lookup, session lookup, email lookup, project lookup, and active project keys.

The ownership check for every protected project route is:

```text
session user -> workspace member -> project -> route
```

Existing production workspaces must never be claimed by the first person who signs in. Supply a one-time owner-link script that requires both the known user email and workspace ID.

## Account API

- `GET /api/v1/auth/config` tells the UI whether GitHub sign-in is ready or private sign-in is unavailable.
- `GET /api/v1/account` returns the signed-in user, their workspaces/projects, roles, and global-admin flag.
- `POST /api/v1/account/bootstrap` is idempotent. When a new user has no memberships, it creates one personal workspace and one default project. It does not create or reveal a key.
- Membership roles are `owner`, `admin`, and `member`. Owner/admin can change project configuration and manage project keys. Members can view recordings and project information.
- Cookie-authenticated mutations reject a request whose `Origin` is not one of the exact trusted origins.

## Project write keys

- Keep the current hash-only key validation and D1/KV ingest lookup.
- `POST /api/v1/projects/:projectId/keys` creates a named key and returns the plaintext exactly once with `Cache-Control: no-store`.
- `DELETE /api/v1/projects/:projectId/keys/:keyId` marks the key revoked and cache sync pending in D1 before deleting its central KV entry. Settings saves and key creation use the same pending state. Failed work retries on key-list reads and a five-minute scheduled repair. Every active writer creates a D1 job before touching KV; the final delete/refresh marker remains until no older writer is unfinished. Because Workers KV is eventually consistent, an edge that already cached the old value can still accept the key during its short propagation window.
- `GET /api/v1/projects/:projectId/keys` returns only audit-safe fields. No plaintext key is stored or returned again.
- Limit key writes to 30 per minute for each user/project, keep no more than 100 audit rows for a project, and remove revoked rows and KV entries after 90 days.
- Never log, persist in browser storage, or place plaintext project keys in URLs.

## Dashboard

- `/login` shows “Continue with GitHub” when Better Auth is ready and a clear unavailable state when it is not.
- `/projects` loads the account, creates the personal workspace when needed, then sends the user to an owned project.
- Project routes require a Better Auth session and workspace membership. `/demo` remains a separate anonymous read-only route tree.
- Replace the hard-coded project and user chrome with account data. Sign out through Better Auth in hosted mode.
- Settings can create and revoke named project keys. A newly-created secret is shown once in a dialog with a clear copy/install action.
- Live replay ticket minting requires a same-origin Better Auth session. Demo playback keeps its separate public read-only path.

## Operator console

- `/_admin` is a first-party surface backed by Better Auth's Admin plugin and small read-only summary APIs.
- Show user count, new users, workspaces, projects, active keys, and a paged/searchable user list.
- Allow a real admin to change roles, ban/unban a user, and revoke sessions. Do not offer password creation, password reset, or impersonation.
- Every operator API checks the Better Auth admin role. Cloudflare Access around `/_admin*` is an optional second gate, not the only authorization check.

## Manual Cloudflare and GitHub work

- Create separate GitHub OAuth Apps for local and production. The callback is `/api/auth/callback/github` on each origin.
- Set the Better Auth secret, public URL, exact trusted origins, GitHub client ID, and GitHub client secret as Worker secrets/config.
- Apply the checked-in D1 migration before enabling hosted auth.
- Sign in once, link any existing production workspace deliberately, and promote the known operator account.
- Optionally put Cloudflare Access around `/_admin*`.

## Verification

- Unit/integration tests cover: public demo unchanged; no-session denial; unsupported authorization-header denial; session-to-project membership; role checks; bootstrap idempotency; key plaintext shown once; create/revoke D1+KV behavior; exact-origin mutation checks; and admin-only routes.
- Dashboard tests cover GitHub and unavailable login states, project routing, key dialog and revoke flow, real account chrome, admin access, and session-authenticated live ticket minting.
- Run `vp install`, `vp check`, `vp test`, the self-host mirror check, dashboard/Worker builds, and a production deploy dry run.
- Do not call the work complete until the full local gates pass. Do not claim production OAuth was tested unless an actual production sign-in was exercised.
