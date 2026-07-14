# Hosted Accounts And Project Keys

Orange Replay uses Better Auth for its hosted dashboard. People sign in with GitHub. There is no password database and no Google sign-in.

The public `/demo` route stays anonymous. A guest can watch the demo, but cannot change settings, create projects, or manage keys.

## Local GitHub Setup

Create a GitHub OAuth App just for local development:

- Homepage: `http://localhost:5200`
- Callback: `http://localhost:8787/api/auth/callback/github`

Copy `apps/worker/.env.example` to the ignored `apps/worker/.env`, then uncomment and fill these values:

```dotenv
BETTER_AUTH_SECRET=at-least-32-random-characters
BETTER_AUTH_URL=http://localhost:8787
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:8787,http://localhost:5200
GITHUB_CLIENT_ID=your-local-client-id
GITHUB_CLIENT_SECRET=your-local-client-secret
```

Start the full local app:

```sh
vp run dev
```

Open `http://localhost:5200/login`. The first sign-in creates a personal workspace and a default project. Add the website origin in Settings before creating the first key; new projects block recorder requests until that origin is saved. To test the operator console locally, promote that account after the first sign-in:

```sh
vp run auth:promote-admin -- --email you@example.com --local
```

Remove or comment all five hosted-auth values to return to the existing local token login. A partial hosted-auth setup fails closed instead of silently using the token.

## Account And Key Boundary

```text
GitHub user -> workspace membership -> project -> project write keys
```

- A dashboard session proves who the person is.
- Workspace membership proves which projects they may open.
- Owners and admins can change settings and create or revoke project keys.
- The recording SDK keeps using a project write key. Website visitors do not need an Orange Replay account.
- A new key is stored only as a hash and its plaintext is shown once.
- Revocation is durable in D1 first, then the central KV entry is removed. If cache work fails, D1 keeps a pending marker and a scheduled repair retries within five minutes; the key list also repairs pending revoked entries before it loads. Every active cache writer registers a D1 job before it can write. A final check is not cleared while any older writer is unfinished, so a stopped or out-of-order request stays visible to the repair loop. After each check, that key moves to a later check time so it cannot keep newer repairs out of the fixed-size queue. Cloudflare KV may still keep an older edge copy for a short propagation window, so this is not an instant global kill switch.
- Key changes are limited to 30 per minute for each user and project. A project keeps at most 100 key audit rows, and revoked rows plus their KV entries are removed after 90 days.

## Operator Dashboard

The first-party operator console is at `/_admin`. It uses Better Auth's Admin plugin for user roles, bans, and session revocation, and Orange Replay summary APIs for counts.

Better Auth also offers a managed Infrastructure dashboard, but it is not self-hosted. The available community Better Auth admin projects were not strong enough to make part of the production security boundary. Keeping this small console in the canonical combined Worker gives Orange Replay one deployment and same-origin cookies. A separate static Worker would not add a security boundary.

For production setup, secrets, the GitHub callback, existing-workspace linking, and the optional Cloudflare Access gate, follow [Production Deployment](./deployment.md).
