# Public analytics and curated replay pages

## Goal

Let a project owner publish one search-friendly public page from Settings. The page shows safe
aggregate analytics and up to ten recordings that the owner selected by hand.

The public address is:

`{PUBLIC_PAGE_ORIGIN}/p/{publicId}`

`PUBLIC_PAGE_ORIGIN` can point at a dedicated Cloudflare custom domain such as
`https://public.example.com`. The same combined Worker serves the dashboard, API, and public page.

## Locked decisions

1. Do not create a second publishing Worker. The existing Worker already owns D1, R2, analytics,
   logging, and the recording access checks.
2. Render the public page on the server with React 19 `renderToReadableStream`.
3. Use TanStack Query for one request-local server cache, dehydrated public data, browser hydration,
   and a visible-tab refresh every 60 seconds.
4. Build a small public React entry separately from the private dashboard entry. It must not import
   private dashboard auth, private query caches, or private routes.
5. Never publish the latest recordings automatically. Owners explicitly choose finalized
   recordings, with a hard limit of ten.
6. Public addresses use random IDs. Do not expose the project ID, organization ID, or private
   session ID in page data or public replay URLs.
7. Unpublishing, removing a recording, retention deletion, or project deletion must fail closed on
   the next request. Public HTML, JSON, manifests, and segments use `Cache-Control: no-store`.
8. Live sessions are never public.

## Data model

Add migration `0015_public_pages.sql`.

### `project_public_pages`

- `project_id` primary key, linked to `projects`
- `public_id` unique random path ID
- `is_enabled` boolean integer
- `revision` integer
- `published_at`, `updated_at`

### `public_page_sessions`

- `(project_id, session_id)` primary key
- `public_replay_id` unique random path ID
- `position` from 0 through 9, unique per project
- `added_at`
- composite foreign key to finalized `sessions`, with delete cascade

The API validates the ten-recording limit and replaces the ordered selection in one D1 batch.

## Authenticated settings API

`GET /api/v1/projects/:projectId/public-page`

- Better Auth owner/admin session only.
- Returns enabled state, current public address, revision, and selected recording summaries.

`PUT /api/v1/projects/:projectId/public-page`

- Better Auth owner/admin session only.
- Hosted session mutations require an exact trusted origin.
- Body is capped at 8 KiB and accepts only `{ enabled, sessionIds }`.
- `sessionIds` must be unique, valid path IDs, finalized, readable, in the same project, and at most
  ten.
- Existing public replay IDs are preserved for recordings that stay selected. Newly selected
  recordings receive new random IDs.

## Public routes

All public routes are rate limited by source IP and query D1 before reading R2.

- `GET /p/:publicId` — server-rendered HTML
- `GET /api/v1/public-pages/:publicId` — safe page JSON used after hydration
- `GET /api/v1/public-pages/:publicId/replays/:publicReplayId/manifest`
- `GET /api/v1/public-pages/:publicId/replays/:publicReplayId/segments/:segmentName`

The public page JSON contains only:

- project display name
- aggregate counts and percentages
- top country, device, browser, operating-system, and entry-page breakdowns
- selected recording summaries using `publicReplayId`

It never contains private IDs, organization data, user data, error messages, R2 keys, or auth data.

The public manifest rewrites its project, session, organization, and segment-key identifiers to the
public IDs before returning it. Segment bytes stay opaque and are never decompressed by the Worker.

## Settings UI

Add a full-width **Public page** card to project Settings:

- publish switch
- plain warning that anyone can view published analytics and chosen recordings
- note that turning publication off blocks new requests immediately, but search results can take
  time to disappear
- public address with Copy and Open actions after the address exists
- selected-recording count (`0/10` through `10/10`)
- a recording picker showing finalized sessions, with explicit switches and a hard ten-item limit
- a confirmation dialog before first publication
- clear saving, saved, and error states

Analytics can be published with zero selected recordings.

## Public page UI and SEO

- Real server HTML must contain the title, summary, metrics, breakdowns, and recording cards.
- Add canonical, description, Open Graph, theme color, and `robots=index,follow` tags.
- Use the Orange Replay dark dotted-grid language, readable without dashboard chrome.
- Keep the replay engine out of the first browser bundle. Load it only after a visitor chooses a
  recording.
- Replay controls must be usable by keyboard and show loading, buffering, playing, paused, ended,
  and error states.
- Add a strict Content Security Policy. Do not use executable inline scripts. The dehydrated Query
  state is escaped JSON in a non-executable script element.
- Deny framing and keep public HTML, JSON, manifests, and segments restricted to same-origin
  resource use.

## Cloudflare and build wiring

- Add `/p/*` to `assets.run_worker_first`.
- Build the public browser entry after the dashboard build into
  `apps/dashboard/dist/public/`.
- Add `PUBLIC_PAGE_ORIGIN` to the Worker environment.
- Production build configuration derives the Custom Domain hostname from
  `ORANGE_REPLAY_PROD_PUBLIC_PAGE_ORIGIN`.
- Cloudflare creates DNS and the certificate when the Custom Domain is attached. No static page
  publication job is needed.

## Tests and acceptance

1. Migration and Drizzle schema match.
2. Anonymous callers cannot read or update settings.
3. Members cannot update public settings; owners and admins can.
4. More than ten, duplicate, missing, cross-project, live, or deleted sessions are rejected.
5. Disabled and unknown pages return 404 from HTML, JSON, manifest, and segment routes.
6. Removing a selected recording immediately makes its public manifest and segments return 404.
7. Public JSON and dehydrated state contain no private project/session/org IDs or error details.
8. Public HTML contains real metric text and SEO tags before JavaScript runs.
9. A new QueryClient is created for every SSR request.
10. Public responses carry the expected CSP, no-store, no-referrer, and no-sniff headers.
11. Public client build, dashboard build, Worker build, `vp check`, and `vp test` pass.

## Manual production step

Set `ORANGE_REPLAY_PROD_PUBLIC_PAGE_ORIGIN` to the chosen HTTPS subdomain before deployment. The
Cloudflare zone must already be active and the hostname must not have a conflicting CNAME record.
No production deploy is part of this implementation task.
