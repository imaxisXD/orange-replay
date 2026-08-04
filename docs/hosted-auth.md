# Hosted accounts and recorder keys

Orange Replay uses Better Auth for its hosted dashboard. People sign in with GitHub. There is no password database and no Google sign-in.

The public `/demo` route stays anonymous. A guest can watch the demo, but cannot change settings, create projects, or manage keys.

## Local GitHub setup

Create a GitHub OAuth App just for local development:

- Homepage: `http://localhost:8787`
- Callback: `http://localhost:8787/api/auth/callback/github`

Copy `apps/worker/.env.example` to the ignored `apps/worker/.env`, then uncomment and fill these values:

```dotenv
BETTER_AUTH_SECRET=at-least-32-random-characters
BETTER_AUTH_URL=http://localhost:8787
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:8787
GITHUB_CLIENT_ID=your-local-client-id
GITHUB_CLIENT_SECRET=your-local-client-secret
```

Start the full local app:

```sh
vp run dev
```

Open `http://localhost:8787/login`. The first sign-in creates a personal team and a default Workspace, then onboarding adds its first Website and prepares that Website's recorder key. To test the operator console locally, promote that account after the first sign-in:

```sh
vp run auth:promote-admin -- --email you@example.com --local
```

Better Auth is the only private dashboard sign-in path. If any required Better Auth or GitHub value is missing, private account and project routes fail closed and the login page explains that sign-in is unavailable. The anonymous read-only `/demo` route keeps working when its own demo values are configured.

When the signed-in user belongs to the configured demo project, private project routes use that session membership. Demo-readable routes keep their anonymous read-only behavior, including for signed-in visitors.

## Account and key boundary

```text
GitHub user -> team membership -> Workspace -> Websites -> Website recorder keys
```

- A dashboard session proves who the person is.
- Team membership proves which Workspaces they may open. The database keeps the older `org` and `project` names for compatibility.
- Owners and admins can change Workspace settings, add Websites, and create or revoke recorder keys.
- Each Website has its own recorder key and exact origin boundary. Website visitors do not need an Orange Replay account.
- An onboarding key is stored as a hash plus a separately encrypted pending copy. The pending copy is deleted after that Website sends its first accepted event.
- Revocation is durable in D1 first, then the central KV entry is removed. If cache work fails, D1 keeps a pending marker and a scheduled repair retries within five minutes; the key list also repairs pending revoked entries before it loads. Every active cache writer registers a D1 job before it can write. A final check is not cleared while any older writer is unfinished, so a stopped or out-of-order request stays visible to the repair loop. After each check, that key moves to a later check time so it cannot keep newer repairs out of the fixed-size queue. Cloudflare KV may still keep an older edge copy for a short propagation window, so this is not an instant global kill switch.
- Key changes are limited to 30 per minute for each user and project. A project keeps at most 100 key audit rows, and revoked rows plus their KV entries are removed after 90 days.

## Operator dashboard

The first-party operator console is at `/_admin`. It uses Better Auth's Admin plugin for user roles, bans, and signing users out on every device. It uses Orange Replay summary APIs for counts.

Better Auth also offers a managed Infrastructure dashboard, but it is not self-hosted. The available community Better Auth admin projects were not strong enough to make part of the production security boundary. Keeping this small console in the canonical combined Worker gives Orange Replay one deployment and same-origin cookies. A separate static Worker would not add a security boundary.

For production setup, secrets, the GitHub callback, existing-workspace linking, and the optional Cloudflare Access gate, follow [Production Deployment](./deployment.md).
