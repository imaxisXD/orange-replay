# Codebase decomposition

## Goal

Make the large production files easier to read and change without changing product behavior, API shapes, stored data, routes, logging, or visual design.

## Rules

- Keep the current public imports working. Existing callers should not need broad rewrites.
- Keep feature-owned code beside the feature. Do not create a general `utils` dumping ground.
- Entry files coordinate work; focused modules own one clear responsibility.
- Aim for route and entry files below 300 lines and focused implementation files below 500 lines.
- A stateful lifecycle coordinator may stay near 600 lines when keeping one mutable state owner is safer than spreading that state across modules.
- Registry-provided UI files, vendored rrweb code, generated files, migrations, and static design references are outside this refactor.
- Add no dependencies.
- Preserve all current uncommitted behavior and do not reformat unrelated files.

## Dashboard boundaries

- `routes/overview.tsx` remains the route entry. Query ownership and page composition stay there.
- Overview KPI, insight, breakdown, error, loading, and shared doorway UI move into route-local `routes/overview/` modules.
- `routes/session-detail/replay-playback.tsx` remains the replay workspace entry. Controls, journey, stage, timeline markers, and display helpers move into `routes/session-detail/replay-playback/` modules.
- Data fetching and state hooks stay separate from display components. Shared components are created only when more than one route owns the same concept.

## Worker boundaries

- `api/handler.ts` remains the public request entry and wide-event boundary.
- Route matching, authorization, demo access, live tickets, project routes, session storage routes, and HTTP response helpers become focused modules under `api/`.
- `do/session-recorder.ts` remains the Durable Object export expected by Wrangler.
- Session state normalization, SQLite/R2 segment storage, finalization, live sockets, and test fixtures become focused modules under `do/session-recorder/`.
- The refactor must preserve hibernation WebSockets, minimal alarm writes, `(tab, seq)` idempotency, immutable R2 writes, prepared D1 statements, fail-closed auth, and one wide event per unit of work.

## SDK and player boundaries

- `sdk/src/sink.ts` remains a compatibility entry that exports the sink contract and implementations.
- Worker-backed batching, inline fallback transport, page-hide final delivery, shared timing, and sink contracts move into `sdk/src/sink/` modules.
- `player/src/player.ts` remains the `OrangePlayer` entry. Recorded playback, live follow, replay viewport/layout, and progress/error reporting move into focused player-owned modules where the class boundary can stay explicit.

## Acceptance

- No route, API response, auth rule, storage key, SQL statement, log event name, or user-visible copy changes.
- Existing unit and integration tests pass without weakening assertions.
- `vp check` and `vp test` pass.
- `vp build apps/dashboard` passes.
- The final source-size report shows the large entry files reduced and lists any deliberate remaining exception.
