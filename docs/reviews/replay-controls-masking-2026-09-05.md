# Replay controls and masking details review

## Impact map

SDK capture reports effective masking settings in each batch. Session storage aggregates the report into the manifest; private viewers receive the report and public viewers receive a coarse summary. This path is unchanged. The built SDK tests assert settings and a rules fingerprint on every intercepted batch.

Masking descriptions now appear only after opening **Session information → Masking details**. The dashboard places this section above the timeline, outside the player card. Public playback places it above the replay stage and waits for the recording to load before offering it. Missing, complete, partial, changed-policy, and canvas descriptions retain their existing meaning. No historical evidence is inferred from current settings.

Desktop size containment makes the player determine the grid height, while the sidebar scrolls inside it. On mobile, the event area is capped at 240px so the information section can grow when opened without clipping text or the empty state. The native disclosure uses keyboard and touch semantics. Global playback shortcuts now ignore summaries and their descendants, just as they ignore other focused controls.

No database, Worker, API schema, authorization, queue, dependency, or deployment changes.

## Surfaces and evidence

- Private and demo dashboard replay share the workspace in session detail and the Sessions panel. The browser fixture includes the panel's enclosing flex column. A 45-event list stays bounded at 1280 and 390px, the frame fits, and keyboard activation of the final event seeks to 950ms.
- Complete and missing reports start collapsed. Enter opens and Space closes the desktop disclosure; touch opens and closes it on mobile. Playback controls contain no masking description.
- The longest partial report, including changed policies and canvas capture, was opened at both widths with long and empty timelines. Text, empty state, and timeline remain inside their bounds; at least one event row remains accessible.
- Public playback covers both widths, complete and missing reports, tab switching, and delayed manifest loading. No missing-report claim appears before loading, and loaded reports remain collapsed until requested. The parent keys the player by recording, resetting its state across sessions.
- Before/after height proof: removing desktop containment fails with `Empty space below playback controls` and `Long timeline does not scroll`; restoring it passes. The initial fixture without the enclosing flex column did not reproduce the bug and was corrected.
- The first disclosure check exposed a real keyboard conflict: Space triggered playback instead of closing details. The shortcut target filter and tests now cover native summaries and nested labels.
- Screenshots were inspected at both widths, including the expanded longest report, against the untouched design reference. Dark panels, dashed borders, compact control spacing, amber playhead, and fonts remain intact.
- Parallel layout assessment and source review identified the loading claim and expanded mobile geometry risks; both have been addressed.

## Validation

- `vp install`: already up to date; no dependencies added.
- `vp check`: no formatting, lint, type errors, or warnings.
- `vp test`: 1,766 tests across 227 files pass.
- Existing development server reused at `http://localhost:8899`; no new server.
- Final browser run: **21 UI cases pass**. The prior **six built SDK cases** passed, including both bundle formats and canvas on/off; recorder code did not change afterward.
- Dashboard and public-page builds pass.
- React Doctor changed-scope scan reports only the pre-existing manual memoization warning in TimelineSidebar. The current changed-scope score is 85/100; the earlier 98/100 scan covered fewer React files, so the scores are not directly comparable. No new diagnostic was introduced.

## Limits and verdict

Local source and browser review pass with no remaining actionable findings. Live WebSocket playback and the complete authenticated production flow were not rerun; their data and interaction logic are unchanged. Direct production manifest navigation was blocked by the browser, so the exact recording's stored report was not retrieved. Missing historical evidence has not been recovered. Included in the approved source commit. No manual deployment or post-release production verification was performed.
