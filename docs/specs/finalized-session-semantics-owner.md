# Finalized-session semantics owner

Status: complete (2026-07-17).

## Problem

D1 and R2 SQL deliberately use different storage mechanics, but their query modules separately
owned the meaning of the finalized recording set. Filter behavior, the friction formula, five sorts,
cursor rules, null-last page ordering, error-row needs, and the `Unknown error` label had to be kept
in sync by editing two implementations.

Static SQL assertions and runtime shadow comparison already guarded parity. This refactor deepens
the semantic module without replacing those guards or pretending the two SQL dialects are the same.

## Decision

`apps/worker/src/query/finalized-session-semantics.ts` is the single owner of:

- the exhaustive `SessionFilter` mapping;
- the `errors * 1000 + rages * 100 + clicks` friction score;
- newest, friction, duration, clicks, and pages ordering;
- sort validation, cursor parsing, cursor rendering, and cursor encoding;
- page-count null-last ordering and null-page cursor behavior;
- whether exact error rows are required;
- the error event kind and the `Unknown error` fallback.

It exposes a small SQL dialect port for columns, safe values, URL-prefix matching, exact error
matching, and warehouse-version visibility. It is not a generic SQL tree or query builder.

## Dialect constraints

The D1 adapter in `session-query.ts` keeps:

- `?` prepared-statement bindings and their existing order;
- live `session_deletions`, export outbox/ledger, and `session_events` subqueries;
- range-based entry URL prefix matching, including the maximum-code-point fallback;
- the D1-only `has_checkpoint` selected response field.

The R2 adapter in `warehouse-query.ts` keeps:

- typed values rendered as escaped literals because R2 SQL has no prepared bindings;
- the existing session/event/deletion CTEs and retry deduplication;
- unversioned deletion application, including v2 date bounds;
- a substring prefix predicate;
- flat filter expressions with no repeated required-field checks, protecting the live R2 SQL
  expression-depth limit.

The adapters remain responsible for storage layout. The semantic module owns only recording-set
meaning.

## Shadow comparison

A successful compare removes only `has_checkpoint` from both session rows before checking them.
That field exists only in D1 today. Responses are not changed.

Every shared session field, row order, and `nextBefore` remains strict. Stats comparison and sparse
D1 error-evidence handling are unchanged.

## File budget

- `apps/worker/src/query/finalized-session-semantics.ts`
- `apps/worker/src/query/session-query.ts`
- `apps/worker/src/analytics/warehouse-query.ts`
- `apps/worker/src/analytics/finalized-read.ts`
- `apps/worker/tests/api-helpers.test.ts`
- `apps/worker/tests/analytics-warehouse-read.test.ts`
- `apps/worker/tests/analytics-compare.test.ts`
- this spec

Do not change schemas, migrations, warehouse tables, Pipeline records, public response types,
dashboard code, runtime source selection, cache policy, deployment configuration, or dependencies.

## Required proof

1. One exact D1 query covers every shared filter key and keeps the prior SQL and binding order.
2. D1 prefix ranges remain surrogate-safe and retain the exact-prefix fallback at the maximum code
   point.
3. D1 and R2 render all five sort/cursor rules, including legacy newest, tied session ids, numeric
   pages, and null pages.
4. R2 true and false filter branches retain their flat expressions, and event CTEs appear only when
   an error detail needs them.
5. R2 session, event, and deletion CTEs keep deduplication, deletion behavior, v2 date bounds, and
   expression-depth protections.
6. A complete successful route-level shadow read reports a match when only `has_checkpoint`
   differs.
7. Comparison still reports a mismatch for a changed shared field or cursor.

## Review map

- Input: existing finalized sessions and stats query parameters.
- Storage: D1 live tables or verified R2 SQL snapshot, unchanged.
- Backend: one semantic module rendered through two storage adapters.
- API: existing sessions/stats responses and cursor format, unchanged.
- User surfaces: Sessions list and metric doorways keep the same rows, order, filters, and labels.
- Not affected: SDK, Durable Objects, recording writes, retention, erasure workflow, billing, and UI.

## Validation

- Focused formatting, lint, and type checks for the eight files above.
- `vp test apps/worker/tests/api-helpers.test.ts apps/worker/tests/analytics-warehouse-read.test.ts apps/worker/tests/analytics-compare.test.ts`
- Diff review using `docs/code-review.md`, including D1/R2 SQL, API cursor behavior, and successful
  shadow comparison.
