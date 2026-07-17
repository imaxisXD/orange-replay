# Public page publication owner

## Goal

Put every public-page storage and recording-availability rule behind one Worker module. Keep the
authenticated Settings route and anonymous page/replay routes as small HTTP adapters.

This is a behavior-preserving refactor. It adds no migration, dependency, route, Worker binding, or
public response field.

## Problem

`api/public-page-settings.ts` and `public-page/data.ts` both read publication rows, selected
recordings, deletion markers, and recording summaries. They also had separate safe entry-path
functions. Anonymous page lookup and replay lookup each repeated `is_enabled = 1`.

That split can fail in two privacy-sensitive ways:

- one response can expose a host, query, or fragment while another still looks scrubbed;
- one anonymous route can keep serving a removed, deleted, or unpublished recording.

## Ownership

Create `apps/worker/src/public-page/publication.ts`. It is the only runtime module allowed to issue
SQL against `project_public_pages` or `public_page_sessions`.

It owns:

- publication creation, enable state, revision compare-and-swap, and mutation tokens;
- ordered selected-recording replacement and stable public replay IDs;
- private publication Settings reads;
- anonymous published-project, selected-recording, and replay-source lookup;
- the shared `is_enabled = 1` published-page SQL scope;
- the shared rule that a selected session must still exist and have no deletion marker;
- public-page origin validation and public URL construction.

The pure `safePublicEntryPath` privacy helper lives in
`packages/shared/src/analytics-privacy.ts` so the Worker and Settings picker use the same rule. It
keeps only an HTTP or HTTPS path. It removes credentials, host, query, and fragment and returns `/`
for missing, invalid, or non-HTTP input.

## Adapters

`apps/worker/src/api/public-page-settings.ts` keeps only:

- request body size and exact JSON-shape checks;
- HTTP status/error mapping and private no-store headers;
- wide-event response fields.

`apps/worker/src/public-page/data.ts` keeps only:

- anonymous and analytics rate limits;
- finalized analytics reads and public response assembly;
- immutable R2 manifest and segment reads;
- manifest ID/key rewriting and response headers.

`apps/worker/src/public-page/handler.ts` remains the SSR/method/CSP adapter. Public React and shared
wire types remain unchanged.

## Locked behavior

- Settings GET/PUT authentication and origin checks remain unchanged.
- Only owner/admin mutations reach the Settings adapter.
- A page may be enabled with zero recordings.
- Public IDs and replay IDs remain random; recordings that stay selected keep their replay ID.
- A stale revision returns `409 public_page_settings_changed` and never retries automatically.
- Missing, cross-project, deleted, or non-finalized selections return
  `400 recording_not_available`.
- Public HTML, JSON, manifest, and segment routes recheck enabled publication state.
- Removing a selection, adding a deletion marker, deleting the project/session, or unpublishing
  blocks the next anonymous recording read.
- Public responses never expose private project, session, organization, storage, or full entry URL
  values.
- R2 objects remain immutable and opaque. The Worker never decompresses replay bytes.

## File budget

- `apps/worker/src/public-page/publication.ts`
- `apps/worker/src/api/public-page-settings.ts`
- `apps/worker/src/public-page/data.ts`
- `packages/shared/src/analytics-privacy.ts`
- `apps/dashboard/src/routes/settings/settings-public-page-card.tsx`
- focused tests for the shared helper, Settings card, Worker routes, origin rules, and architecture
  boundary
- this spec

Do not change migrations, shared response types, public React code, Worker routing, deployment
configuration, or dependencies.

## Required proof

1. A full URL containing credentials, a private host, query data, and a fragment becomes only its
   path in private Settings, public JSON, entry-page breakdowns, and SSR HTML.
2. Those outputs contain none of the secret URL parts or private IDs.
3. Removing a recording keeps the page available but removes its card; its old manifest and segment
   immediately return 404.
4. Unpublishing while keeping a recording selected makes HTML, JSON, manifest, and segment routes
   return 404. Private Settings keeps the selection for later republishing.
5. A deletion marker hides the recording from public and private summaries, blocks manifest and
   segment reads, and prevents reselection.
6. Existing first-save races, stale revisions, selection limits, cross-project checks, SSR headers,
   and manifest redaction remain green.
7. An architecture test rejects publication-table SQL outside the new owner.
8. Focused format, lint, type, and test checks pass.

## Review map

- Input: owner publish/unpublish or recording selection; visitor page/replay request.
- Storage: D1 publication/selection/session/deletion rows; immutable R2 manifest and segments.
- Backend: revision, enabled state, selection availability, safe path, analytics read, replay access.
- API: existing private Settings and anonymous page/replay contracts, unchanged.
- User surfaces: Settings card and picker; public SSR/hydrated analytics page; public replay player.
- Not affected: SDK, Durable Objects, KV, Queue, Pipeline, billing, migrations, layout, and CSS.
