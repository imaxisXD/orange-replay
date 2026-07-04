# F3 — Player polish: friction visibility + cockpit depth

## Goal

The playback engine is solid but the cockpit undersells it (user feedback: effects too subtle, no dead-click view, nothing that reads as insight). This round adds five visible capabilities, all computed from data we already capture — no new SDK capture, no server changes. Scope: `packages/player/**`, `apps/dashboard/**`, `fixtures/demo-site/tests/**` (e2e additions only). Everything styled per `docs/design-language.md`; I will screenshot-judge against it.

## 1. Dead-click detection + markers

**Definition (implement exactly):** a click index event is a _dead click_ when, in the decoded event stream, the window `(t, t + 600ms]` contains **no** DOM mutation (IncrementalSnapshot source Mutation), **no** navigation (Meta or nav index event), **and** no error index event in `(t − 300ms, t + 600ms]` (a click that triggers an error is an _error click_, not a dead one — never double-flag). Clicks whose detail is `[blocked]` are excluded.

- New pure module `packages/player/src/friction.ts`: `detectDeadClicks(events, timeline): DeadClick[]` where `DeadClick = { t, detail }`. Unit-fixture every branch above.
- Player emits them with the existing `timeline` event payload (extend the type additively) once segments decode; recompute as more segments load.
- Timeline bar: dead clicks render as **hollow rings** (2px stroke, `--dim` color, 8px) sitting on the baseline — visually distinct from solid red error markers.
- Sidebar: dead-click rows (dot style: hollow), label "dead click", detail = selector, click-to-seek like other rows.
- Session-detail meta strip: if count > 0, add a "Dead clicks" stat (amber value — it is a friction warning).

## 2. Louder overlay effects

Current effects are too quiet at 1× scale. Change defaults (all already parameterized in overlay options; update the defaults in the player and pass design tokens from the dashboard):

- Click ripple: radius 44px (was ~28), lifetime 700ms (was ~400), 2px stroke, amber token `#f5a623`, second echo ring at 50% opacity.
- Rage burst: triple concentric rings, red token `#f4534e`, lifetime 900ms.
- Cursor trail: width 2px, teal token `#2dd4bf`, fade window 1.5s.
- Dead click (new): at its timestamp, a brief "nothing happened" pulse — a small gray X fading over 500ms at the click point.

## 3. Activity heat strip on the scrubber

A 4px-tall lane rendered directly above the timeline baseline inside the player bar: 100 equal buckets across the session, bucket value = count of index events in that time span (from the **manifest timeline only** — no payload processing), colored by the design-language heat ramp (`#113732 → #14746a → #2dd4bf → #f5a623 → #f4534e`, empty = transparent), max-normalized. Clicking the strip seeks (reuse timeline seek math). Pure bucket function in `friction.ts` (`bucketActivity(timeline, durationMs, buckets=100)`) with unit tests (empty session, single event, uniform, spike).

## 4. Journey breadcrumbs

Above the player viewport (inside the player card, `border-b border-dashed border-dash` below it): a horizontal strip of the session's page path — one chip per nav (entry URL first, then each `nav` index event): mono 11px path text in neutral chips, middot separators, current-position chip highlighted (amber text) as playback crosses each nav timestamp. Click a chip → seek to that nav. More than 6 pages: middle-collapse with a "+N" chip that expands on click. Empty for single-page sessions (render nothing, no empty shell).

## 5. Jump to first error

When the session has errors: a ghost button in the player bar (right of the timecodes): red dot + "First error" → seeks to `firstErrorT − 2000ms` (clamped ≥ 0) and plays. Hidden when no errors.

## Tests

- Unit: `friction.ts` full branch coverage (dead-click windows, error-click exclusion, blocked exclusion, bucket math edge cases).
- e2e additions to `product.e2e.ts` (existing recorded flow already produces the needed data): after playback step assert (a) the heat strip element exists with ≥1 non-transparent bucket, (b) the demo flow's known dead click renders a marker (the demo site has a "Save settings" button whose handler does nothing DOM-visible — verify this in the fixture first; if its handler mutates DOM, add a genuinely inert button `data-testid="inert"` to the fixture and click it in the recording step), (c) breadcrumbs show both pages and clicking the second seeks forward, (d) "First error" button jumps the timecode.
- Keep every existing test green.

## Constraints & DoD

Design-language compliance mandatory (tokens, `.lit`, mono numerals; no new registry-replaceable components hand-rolled). No SDK/worker changes. `vp check` + `vp test` + full Playwright suite green (run the dashboard-scoped tests; I run the browser suite). Report per-item completion + screenshots-worthy notes; I do the visual judgment per the ledger protocol (including a geometry-mismatch pass).
