# Private replay asset fidelity

Status: implemented and validated (2026-08-09).

## User result

Finalized private replays can restore public stylesheets, web fonts, and CSS background images without making the replay frame contact the recorded site. Project owners can turn this off with **Preserve replay styling** in Settings.

This is best-effort DOM reconstruction, not a video or a pixel-perfect promise. Playback still works when every asset is missing.

## Why this design

- Customer pages do not capture or upload font, stylesheet, or background-image files.
- `collectFonts` stays off.
- The recorder bundle does not grow for this feature.
- Asset work starts only after the recording is finalized and indexed.
- The locked replay frame keeps `connect-src 'none'` and makes no outside request.

## Flow

1. The normal finalize job indexes the session and enqueues `session.replay-assets`.
2. The asset job reads at most three full snapshots from bounded replay segments.
3. It finds public stylesheet, font, and image URLs in snapshot attributes and CSS.
4. A guarded fetcher downloads safe public files without cookies or authorization headers.
5. Bytes are stored once under `replay-assets/sha256/{hash}`. D1 stores hashes and tenant/session access rows, not original URL strings.
6. A private `p/{projectId}/{sessionId}/asset-map.json` stores the exact URL-to-hash map for that replay. It is deleted with the recording.
7. The authenticated dashboard player loads a bounded set of bytes, sanitizes CSS, creates `blob:` URLs, and revokes them when the player closes.

Public share pages do not receive the asset map or bytes in this release.

## Hard limits

| Work                     |                       Limit |
| ------------------------ | --------------------------: |
| Full snapshots read      |               3 per session |
| Snapshot nodes inspected |                     100,000 |
| CSS text inspected       |           2 MiB per session |
| Candidate URLs           |              64 per session |
| Manifest read            |                       2 MiB |
| Segment read             |                  8 MiB each |
| Decoded batch            |                      16 MiB |
| Public fetches           | 256 per project per UTC day |
| Attempts for one URL     |               2 per UTC day |
| Stylesheet response      |                       2 MiB |
| Image or font response   |                       5 MiB |
| Stored asset bytes       |         512 MiB per project |
| Player asset bytes       |      20 MiB per replay view |
| Player fetch concurrency |                           6 |
| Nested stylesheet depth  |                           8 |

The storage and daily-fetch limits are project-wide. A project can contain several Websites, so this is stricter than a separate limit for every Website.

## Security and privacy rules

- Only `http` and `https` URLs on ports 80 or 443 are allowed.
- Local, private, reserved, internal, Orange Replay service, and unsafe redirect targets are rejected.
- A public DNS check runs before every fetch and every redirect. Workers cannot pin the checked IP to the later fetch, so DNS rebinding remains a documented residual risk.
- Query names that look like credentials, tokens, sessions, or signatures are rejected.
- Fetches send no cookies or authorization data and use an identifying Orange Replay user agent.
- Responses have a five-second timeout, streamed size limits, a narrow MIME allowlist, and file-signature checks.
- SVG, scripts, HTML, video, audio, and EOT are not stored.
- Asset serving requires the signed-in member to have access to the exact project, session, and asset hash. A bare global hash is never enough.
- Browser caching is private and limited to five minutes so retention and privacy deletion have a clear bound.
- Encrypted recordings skip extraction.

## Cache, versioning, and deletion

- Asset bytes are immutable and addressed by SHA-256.
- A project's URL-to-hash lookup is reused for at most 24 hours. This avoids downloading the same file for every session while allowing a same-URL deployment to refresh.
- The private session map is the idempotent completion marker. A retry that finds it acknowledges without repeating work.
- Cleanup waits 24 hours before removing an unreferenced asset. This prevents cleanup from racing a capture that has stored bytes but has not linked the session yet.
- Daily attempt and fetch counters older than seven days are deleted.

## Known limits

- Private, signed, login-only, VPN-only, and blocked assets are not captured.
- A file may change between the person's visit and the post-finalize fetch. The replay can therefore receive a nearby version rather than the exact bytes viewed.
- Cross-origin images whose URL rrweb removed at capture cannot be recovered by this backend-only path.
- Active/live replay does not wait for asset capture. The improved styling applies after finalization or on a later replay load.
- Font storage and private replay serving require the customer's right to use those files. Product terms must state that responsibility before broad release.

## Delivery cost change

The small loader fetches config and makes the deterministic sampling decision before downloading rrweb. Sampled-out visits stop after the loader/config request. Sampled-in visits receive an immutable content-hashed recorder URL. The stable `/or-recorder.js` stays as the compatibility fallback.

Budgets stay fixed: 2 KiB gzip for the loader and 36 KiB gzip for both recorder builds, with 32 KiB remaining the recorder target.

## Required proof

- SDK tests: sample-out makes no recorder request; sample-in loads the hashed file; the full SDK reuses loader config.
- Worker tests: URL and DNS rejection, redirects, timeouts, byte and file checks, extraction caps, opt-out, queue retry/completion, and exact tenant/session authorization.
- Player tests: CSS dependency rewriting, asset byte limits, optional-route behavior, and blob revocation.
- UI test: Settings shows and changes **Preserve replay styling**.
- Browser fidelity test: external stylesheet, font, and background assets render while replay-frame outside requests remain empty.
- Full `vp check`, `vp test`, SDK budget, production build, template mirror check, schema check, and React Doctor.
