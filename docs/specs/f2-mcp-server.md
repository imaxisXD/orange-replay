# F2 — MCP server: make replay data usable by the customer's own AI tools

## Goal (what exists when this ships)

A small companion package, `@orange-replay/mcp`, that a developer runs locally (`npx orange-replay-mcp`). It implements the Model Context Protocol over stdio so tools like Claude Code and Cursor can, mid-debugging-session, ask their own AI assistant things like _"list yesterday's sessions with errors on /checkout"_ and _"give me the reproduction bundle for the worst one"_ — and the assistant pulls real structured data from the developer's Orange Replay deployment (self-hosted or local dev).

This is deliberately a thin, local bridge: we do not build our own chat features. We make the data our product already has consumable by the agents users already run. Composes directly with F1: two of the tools serve F1's generated artifacts, which is why F1's repro module must stay dependency-free and Node-compatible.

Acceptance demo: with the local worker running and a recorded error session present, configure the server in Claude Code (`claude mcp add orange-replay -- npx orange-replay-mcp --url http://127.0.0.1:8787 --project p1`), then ask the assistant to find sessions with errors and produce a regression test for one. The assistant succeeds using only the exposed tools.

## Package shape

- `packages/mcp` mirroring sibling packages: source exports (`"." → ./src/index.ts`), `bin: { "orange-replay-mcp": "./src/cli.ts" }` wired the way vp-built packages do binaries (check how other packages handle bin with vp pack; if source bin is not viable, a tiny dist-built bin is acceptable — document the choice).
- **New dependency (justified):** `@modelcontextprotocol/sdk` — the official MCP SDK; hand-rolling the protocol is error-prone and not our business. `zod` already exists in the workspace for tool input schemas.
- Files: `src/cli.ts` (arg/env parsing → start), `src/server.ts` (MCP server + tool registration), `src/rest.ts` (typed client over our existing API), `src/decode.ts` (segment bytes → event JSON in Node), `src/tools/*.ts` (one file per tool), `src/redact.ts` (output caps), `README.md`.

## Configuration

Flags win over env; both supported: `--url` / `ORANGE_REPLAY_URL` (required), `--token` / `ORANGE_REPLAY_TOKEN` (required; for local dev this is the dev token), `--project` / `ORANGE_REPLAY_PROJECT` (required v1 — single-project scope keeps tool schemas simple). Startup validates by calling the health route and one authenticated route; on failure print a one-line actionable message. The token must never appear in logs, errors, or tool outputs — `redact.ts` owns scrubbing it from any error text.

## Data path (Node decode)

`get_failure_bundle` / `get_repro_script` need decoded events server-side (no browser):

1. Fetch the manifest via the existing manifest route.
2. Fetch each segment (existing segment route, binary). Concurrency 4.
3. Parse containers with `parseSegment`/`segmentBatch` from `@orange-replay/shared/wire` — never re-implement.
4. Each contained batch payload: try `node:zlib` `gunzipSync` (gzip magic check first, same convention as the player's decoder — plain JSON fallback).
5. `JSON.parse` → event arrays → sort by timestamp → feed `buildRepro(events, manifest)` from `@orange-replay/player` (the F1 pure module).

Guards: refuse sessions whose manifest `bytes` exceed 25 MB with a clear message ("session too large for tool transport — open it in the dashboard"); total per-call budget 30s; on any segment failure return a partial-data error naming the segment.

## Tools (exact contracts)

1. **`list_sessions`** — input `{ hasErrors?: boolean, country?: string, minDurationMs?: number, sinceMs?: number, untilMs?: number, limit?: number (default 20, max 50) }` → output array of `{ sessionId, startedAt, durationMs, entryUrl, errors, rages, clicks, browser, os, country, city, bytes }`. Maps to the existing sessions list route + its filters; client-side post-filter for params the route lacks, documented per field.
2. **`get_session_timeline`** — input `{ sessionId }` → `{ session: {…meta}, timeline: [{ t, kind, detail? }] }` straight from the manifest (index events only — cheap, no segment fetches).
3. **`get_failure_bundle`** — input `{ sessionId }` → the F1 bundle JSON (schema `repro-bundle/1`).
4. **`get_repro_script`** — input `{ sessionId }` → `{ language: "typescript", framework: "playwright", source: string }`.
5. **`list_live_sessions`** — input `{}` → presence rows from the live route (id, entryUrl, startedAt, lastSeen, country, city, browser).

All tool outputs pass through `redact.ts`: cap any single string at 2,000 chars, cap total serialized output at 256 KB (truncate `steps` tail with an explicit `truncated: true` marker), strip the token if it ever appears. Tool errors: map 401 → "authentication failed — check ORANGE_REPLAY_TOKEN", 404 → "session not found", network → "cannot reach <url>"; never dump raw stack traces into tool results.

## README (part of the deliverable)

Sections: what it is (one paragraph), install & run, configuration table, Claude Code setup (`claude mcp add … -- npx orange-replay-mcp --url … --project …`), generic `mcpServers` JSON block for other clients, the five tools with one-line descriptions, three example prompts, privacy note (all served data was scrubbed/masked at capture; the server adds no new exposure — it reads the same API the dashboard uses).

## Tests (Node env, no workerd)

- Config parsing: flags/env precedence, missing-required messages.
- REST client against mocked `fetch`: auth header set, filter mapping, error mapping.
- Decode: fixture segments built with `buildSegment`/`encodeIngestBody` from shared (wire-conformant by construction), gzip and plain-JSON payloads, corrupt segment → partial-data error.
- Tools end-to-end against the mocked REST layer: each tool's happy path + one failure path; size-cap truncation behavior; token never present in any output (grep the serialized results).
- One golden test: fixture error-session → `get_repro_script` output contains the goto step and the final assertion block.

## Constraints & DoD

No worker/API changes at all. New dep limited to the MCP SDK. `vp check` and `vp test` green at root; the package's tests runnable in isolation. Report: files, the bin-wiring decision, every place a size cap can trigger, anything incomplete.
