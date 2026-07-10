# F5 - Sessions triage workspace

## Why

The original sessions table made every row wide but gave little help deciding which recording to watch. The accepted implementation keeps the useful F4 data and turns the route into a two-pane triage workspace: a compact decision rail on the left and the selected replay on the right.

Authority: `design-final.html`, `docs/design-language.md`, and the current route behavior in `apps/dashboard/src/routes/sessions/`.

## Data contract

- The Worker stores `activity_hist` as eight activity levels plus an error bit mask.
- Shared `encodeActivityHist` and `decodeActivityHist` own the wire format.
- Session list rows expose activity history, page count, errors, rage clicks, duration, client, location, and start time.
- Legacy rows may have no activity or page data. The UI shows an honest empty state instead of invented values.
- Every filter remains URL-backed through the shared `SessionFilter` contract.

## Left rail

- A 320px `.lit` panel contains the toolbar, active filter chips, result count, and session cards.
- Cards show entry path, duration, activity sparkline, client/location context, and only meaningful error or rage pills.
- An amber dot marks unwatched sessions and fades after selection.
- Selecting a card pushes browser history. Keystroke-driven filters replace the current history entry.
- The selected card scrolls into view and exposes list/listitem semantics with a composed accessible label.

## Replay stage

- The selected recording opens inline without navigating away from the sessions route.
- The stage reuses the real session detail player, timeline, journey, and friction controls.
- A recording with no replay segments shows an explicit metadata-only state instead of a black player surface.
- Empty, loading, error, and no-selection states use direct text and recovery actions.

## Filters and counts

- Country, duration, errors, rage, watched state, time range, and exact URL filters round-trip through the URL.
- Each active chip removes only its own filter.
- Count copy handles singular, plural, pagination `+`, and range suffixes.
- No-match state names the active filters and provides a clear reset action.

## Activity sparkline

- Eight fixed bars use the same quiet activity color as the player scrubber.
- Error buckets use the danger color.
- Missing or malformed history renders a simple baseline.
- The sparkline is decorative; text and status pills carry the meaning for assistive technology.

## Verification

- Shared codec tests cover empty, uniform, spike, error, and malformed values.
- Worker tests cover finalize persistence and sessions API output.
- Dashboard tests cover filtering, counts, watch state, selection search state, and activity rendering.
- Visual review covers both sparse and dense results, short viewports, selected-card visibility, metadata-only sessions, and keyboard/screen-reader behavior.
- `vp check`, `vp test`, and the dashboard production build must pass.
