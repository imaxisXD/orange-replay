# 001 — Hard-cut the play/pause glyph swap

- **Status**: DONE
- **Commit**: f1c855f
- **Severity**: HIGH
- **Category**: Purpose & frequency
- **Estimated scope**: 1 file, ~5 lines

## Problem

The replay play/pause button is the highest-frequency control in the product: it is clicked constantly during session triage and is also bound to the spacebar on the timeline slider. Every toggle runs a 300ms spring cross-fade (scale 0.25→1 + 4px blur) via `IconSwap`. The animation-frequency rule: actions hit 100+ times/day — especially keyboard-initiated ones — get **no animation, ever**. At this frequency the cross-fade reads as lag between pressing space and seeing the state change.

```tsx
// apps/dashboard/src/routes/session-detail/replay-playback/replay-controls.tsx:47-49 — current
<IconSwap swapKey={playing ? "pause" : "play"}>
  <PlayPauseShape playing={playing} />
</IconSwap>
```

The keyboard binding that makes this high-frequency (do not change it, context only):

```tsx
// replay-controls.tsx:79-82
            } else if (event.key === " " || event.key === "Spacebar") {
              event.preventDefault();
              player.actions.togglePlayback();
            }
```

`IconSwap` (`apps/dashboard/src/components/ui/icon-swap.tsx`) itself is fine and stays as-is — its other call sites (copy→check in `session-detail.tsx:252` and `install-snippet-builder.tsx:173`, show/hide token in `login.tsx:88`) are occasional actions where the cross-fade is appropriate.

## Target

The glyph swaps instantly — a hard cut, zero animation. `PlayPauseShape` already renders the correct glyph from the `playing` prop, so the fix is removing the `IconSwap` wrapper:

```tsx
// replay-controls.tsx — target (inside the button at line 41-50)
<PlayPauseShape playing={playing} />
```

If `IconSwap` is no longer imported anywhere in this file after the edit, remove its import statement.

## Repo conventions to follow

- This app's motion philosophy is deliberately minimal — see the storyboard comment at `apps/dashboard/src/index.css:526-531` ("state changes only, no choreography"). An instant glyph cut is on-brand.
- The correct-by-contrast exemplar is `apps/dashboard/src/routes/session-detail.tsx:252` — copy→check is occasional, so it keeps `IconSwap`. Do not "fix" that one.

## Steps

1. In `apps/dashboard/src/routes/session-detail/replay-playback/replay-controls.tsx`, replace the three lines at 47-49 (`<IconSwap swapKey={...}>` … `</IconSwap>`) with the bare `<PlayPauseShape playing={playing} />`.
2. Remove the now-unused `IconSwap` import from the top of the file (only if no other usage remains in this file).

## Boundaries

- Do NOT touch `apps/dashboard/src/components/ui/icon-swap.tsx` or any other `IconSwap` call site.
- Do NOT change `PlayPauseShape`, the button markup, aria-labels, or the keyboard handler.
- Do NOT add new dependencies.
- If the code at the cited lines doesn't match the excerpts (drift since commit f1c855f), STOP and report instead of improvising.

## Verification

- **Mechanical**: `vp check` and `vp test` from the repo root — both must pass.
- **Feel check**: run the dashboard (`vp dev`), open a session replay, and:
  - Click play/pause rapidly — the glyph must flip instantly with no fade, blur, or scale.
  - Focus the timeline and spam spacebar — state indication is immediate; there is never a moment where both glyphs are visible.
  - Confirm copy buttons elsewhere (session-detail header machine-id chip) still cross-fade copy→check.
- **Done when**: play/pause renders a hard cut, all other `IconSwap` sites are untouched, and `vp check` / `vp test` pass.
