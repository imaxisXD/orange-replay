# Architecture improvements — 2026-09-05

The user approved implementing the architecture audit recommendations in priority order. Keep the Cloudflare storage and session coordination model. Change a platform or storage engine only when measured results justify its migration cost.

## Delivery order

| Step | Change                                                                                                        | Required proof                                                                                                                                | Status       |
| ---- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1    | Align capture and playback limits; apply the asset deadline to the whole download                             | A real SDK batch that failed before now decodes; unsafe sizes still fail; stalled DNS, headers, redirects, and bodies end within the deadline | Done locally |
| 2    | Keep recoverable finalization work until the index confirms it; give styling jobs their own queue             | Retry exhaustion, lost delivery, duplicate delivery, deletion, expiry, and restart tests; compatible deployment and self-host configuration   | Done locally |
| 3    | Admit warehouse work after a cache miss; show delivery delay honestly; isolate live-count and export failures | Cache-hit accounting, stale/empty/pinned views, unavailable live counts, and fair retry tests through API and dashboard                       | Done locally |
| 4    | Make the masking contract explicit and record the applied policy                                              | Capture, wire, storage, settings, legacy recording, and policy-change tests                                                                   | Done locally |
| 5    | Preserve tab identity and let the viewer switch tabs or follow a tab-specific event                           | Two-tab capture through manifest and player; legacy fallback; exact UI selection and seek behavior                                            | Done locally |
| 6    | Reconcile schema checks and architecture claims; record when larger scaling changes are justified             | Fresh migration comparison; cost assumptions and limits linked to source; full quality gates and review                                       | Done locally |

## Change rules

- Keep existing uncommitted work. The task baseline records its patch, status, and source hashes outside the repository.
- Keep durable session state, idempotency, tenant authorization, deletion fences, immutable replay objects, and hibernation eligibility.
- Never inflate recording payloads on ingest. Resource checks in the capture and player workers must retain streaming behavior.
- Do not raise the SDK's 36 KiB gzip ceiling to hide growth.
- Do not silently replace unknown counts with zero or label delayed analytics as current.
- Preserve today's input and configured-text masking. A stronger default is a separate product policy change; any such choice must be consistent in capture, stored metadata, settings, and documentation.
- Run focused regression tests after each step, then the full repository gates. Test the rendered interface for changed visible behavior and record any missing proof.
- Source changes, local migrations, and local verification are authorized. Production provisioning, deployment, and pushing remain separate actions.

## Review record

Each completed step must record its impact map, affected surfaces and states, evidence, findings, untested paths, and review result, as required by `docs/code-review.md`.

The completed review is `docs/reviews/architecture-improvements-2026-09-05.md`. All six steps have local implementation and regression evidence. Production provisioning and deployment remain separate; larger scaling changes stay subject to the measurements below.

Before this work, `vp check` passed with six existing rrweb warnings, and `vp test` passed 1,679 tests across 217 files. The schema checker reported existing differences in `projects`, `project_websites`, and `session_deletions`. These are baseline results, not validation of the changes below.

The existing dashboard server is at port 8899. Its live demo is unavailable in the current configuration; use a controlled local fixture for changed interface states and do not claim production proof from that fixture.

## Larger changes that require measurement

- D1 project routing: measure per-database queueing, size, and request cost before adding shards or replacing the database.
- Warehouse serving tables: compare scan bytes, query time, and exact results over 1-, 30-, and 730-day windows, including late backfills, before changing table layout.
- Erasure throughput: measure pending age, completed sessions per run, and catalog commit time before replacing per-session processing with partition work. Preserve the existing two-check completion proof.
- Accepted-storage accounting: compare request cost and quota accuracy before moving from exact reservations to coarse allowances. Do not change the production flag as part of a local refactor.

These are decision criteria, not evidence that a migration is already beneficial.
