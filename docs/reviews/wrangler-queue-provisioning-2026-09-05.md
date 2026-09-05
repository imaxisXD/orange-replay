# Wrangler queue provisioning review — 2026-09-05

## Result and impact map

Wrangler is pinned to **4.129.0**. The previous **4.110.0** stopped the deployment when a newly configured queue was missing. The new version creates that queue using its configured name and reuses it on later uploads and deployments. No provisioning wrapper or extra deployment command is needed.

| Layer              | Change and effect                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Operator and build | The workspace catalog and lockfile select one Wrangler version for the Worker, dashboard tooling, and purge runner.                                                                              |
| Type definitions   | Both Workers use `@cloudflare/workers-types` **5.20260903.1**, satisfying Wrangler's peer requirement. These declarations do not add application runtime code.                                   |
| Stored resources   | Missing producer queues can be created during the fallback upload or deploy. Deployment connects consumers and creates missing dead-letter queues. Existing names and resource IDs are retained. |
| Backend and API    | No application logic, authorization, schemas, response fields, or migration SQL changed. The existing deployment ordering and secret checks remain in force.                                     |
| Frontend and SDK   | No components, interactions, visible text, or recording/playback contracts changed. The production bundle still uses the existing application sources.                                           |
| Self-hosting       | The guide selects the pinned workspace CLI. Generated configuration comments now describe queue creation during deployment. Binding values and migration files are unchanged.                    |

[Cloudflare's configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) documents automatic provisioning. Queue support arrived in [Wrangler 4.113.0](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler@4.113.0). The selected [4.129.0 release](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler@4.129.0) meets the repo's release-age policy and supports the existing Node 22.18 build environment.

## Surfaces and state checks

The affected paths are the D1 fallback `versions upload`, the production `deploy`, repeated deployments, Worker and purge-runner bundle generation, and self-host setup. A temporary Worker had no routes, with `workers_dev` and `preview_urls` disabled. Its queue configuration used an explicit producer name, a matching consumer, and a dead-letter queue, as production does. It had no production bindings or application secrets, and no messages were sent.

| Check against real Cloudflare resources                  | Observed result                                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Wrangler 4.110.0 uploads with the producer queue missing | Failed with the same missing-queue error. Active Worker version stayed unchanged.                                             |
| Wrangler 4.129.0 uploads the same configuration          | Created the exact named queue and uploaded the version. Active Worker version stayed unchanged; no consumer was attached yet. |
| Repeat version upload                                    | Reused the same queue ID and left the active version unchanged.                                                               |
| Deploy                                                   | Reused the producer queue, attached the consumer, and created the named dead-letter queue.                                    |
| Repeat deploy                                            | Retained both queue IDs and the consumer ID.                                                                                  |
| Cleanup                                                  | Removed the test consumer, Worker, and both test queues. API reads confirmed their removal.                                   |

Provisioning uses Cloudflare's default behavior. A token still needs Queue permissions. A consumer-only queue without a matching producer binding must already exist. The upgrade does not prevent permission failures, account limits, or Cloudflare outages.

## Local evidence

- `vp install --frozen-lockfile`: passes after the package-manager-generated lockfile update.
- `vp check`: zero warnings, lint errors, or type errors.
- `vp test`: **1,766 tests across 227 files** pass after aligning the type packages.
- `vp run -r build`: all **8 workspace builds** pass, including both Wrangler dry runs.
- `vp run db:check`: migration output matches Drizzle across **34 tables**.
- `node scripts/mirror-template.mjs --check`: passes.
- `vp run budget`: all SDK hard limits pass. Existing 32 KiB target warnings remain; the IIFE still has only 3 bytes below its 36 KiB hard limit.
- `vp why -r wrangler`: one version, **4.129.0**, including the dashboard plugin's resolved Wrangler. `pnpm peers check` reports only the existing Better Auth / Drizzle mismatch.

The lockfile changes are limited to Wrangler, matching Worker types, Wrangler's dependencies, and the resulting peer-resolution entries. The existing Cloudflare Vite plugin remains **1.44.0**, whose Wrangler peer range accepts this version. Its separately pinned Miniflare remains unchanged.

## Findings and untested areas

No defect was found in the changed deployment paths. The full dependency audit is still **21 advisories: 1 critical, 15 high, and 5 moderate**, with the same advisory IDs before and after this change. This is not a clean security audit.

The critical [Vitest Browser Mode advisory](https://github.com/advisories/GHSA-p63j-vcc4-9vmv) affects the existing **4.1.9** development dependency; its patched release is **4.1.10**. The existing Vite plugin's Miniflare still carries affected `sharp` and `undici` versions, although the new Wrangler's copies are patched. Other existing findings involve `fast-uri`, `brace-expansion`, `postcss`, `nanoid`, and `browserslist`. These need a separate, coordinated toolchain update.

The existing local dev server was preserved. A fresh integrated Vite dev process and a new interactive browser pass were not run; the Mac was locked. No UI code changed. Production release verification uses the existing Cloudflare Workers Builds check, active Worker version, retained queue bindings, and the repository's public API/auth and analytics checks. A successful source commit alone is not proof of deployment.

## Verdict

The focused queue-provisioning upgrade passes its local and live before/after checks. Production delivery must complete through the existing Workers Builds pipeline, with the deployment and public checks verified separately. Existing security advisories and the untested dev-process restart remain explicitly outside this verdict.
