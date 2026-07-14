# 005 — Trim the timeline playhead flash to the UI duration budget

- **Status**: DONE
- **Commit**: f1c855f
- **Severity**: MEDIUM-LOW
- **Category**: Easing & duration
- **Estimated scope**: 1 file, 1 value

## Problem

When the user jumps the replay playhead (timeline-sidebar row click, journey-breadcrumb click, first-error button), the playhead flashes an amber glow to show where it landed. Good purpose — but the flash runs **520ms**, well over the 300ms budget for UI animations, on a surface hit constantly during triage. Rapid seeks re-fire it (the element is re-keyed per flash), so the long tail means the glow is often still decaying when the next jump lands.

```css
/* apps/dashboard/src/index.css:522-524 — current */
.timeline-playhead-flash {
  animation: timeline-playhead-flash 520ms ease-out;
}
```

The keyframes (unchanged by this plan, shown for context):

```css
/* apps/dashboard/src/index.css:506-516 */
@keyframes timeline-playhead-flash {
  0% {
    filter: drop-shadow(0 0 0 oklch(0.784 0.159 72.991 / 0));
  }
  35% {
    filter: drop-shadow(0 0 12px oklch(0.784 0.159 72.991 / 0.95));
  }
  100% {
    filter: drop-shadow(0 0 0 oklch(0.784 0.159 72.991 / 0));
  }
}
```

## Target

Same flash, tightened to the budget:

```css
/* target */
.timeline-playhead-flash {
  animation: timeline-playhead-flash 240ms ease-out;
}
```

240ms keeps the 35% peak at ~84ms — the glow still reads clearly as "the playhead landed here" but finishes before the eye moves on. Keyframe percentages stay as-is.

## Repo conventions to follow

- This class lives in the hand-authored motion section of `apps/dashboard/src/index.css`, alongside the storyboard comment at line 526 — edit in place, keep the file's formatting.
- The reduced-motion block at `index.css:559-567` already lists `.timeline-playhead-flash` under `animation: none` — leave it.

## Steps

1. In `apps/dashboard/src/index.css:523`, change `520ms` to `240ms`.

## Boundaries

- Do NOT change the keyframes, the amber color values, or `Playhead` in `replay-controls.tsx` (the `key={flashKey}` remount is the intended re-fire mechanism).
- Do NOT touch any other animation in `index.css`.
- If the code at the cited line doesn't match the excerpt (drift since commit f1c855f), STOP and report instead of improvising.

## Verification

- **Mechanical**: `vp check` — passes (pure CSS change; `vp test` should be unaffected but run it too).
- **Feel check**: run the dashboard, open a session replay:
  - Click timeline-sidebar rows: each jump produces a crisp amber pulse that clearly marks the landing spot and is fully gone in under a quarter second.
  - Click several rows in fast succession: pulses feel like discrete taps, not an ongoing smear. If 240ms feels too clipped to register the landing spot (this is a judgment call code can't settle), 280ms is the acceptable upper alternative — pick by eye, stay ≤300ms.
- **Done when**: the flash duration is ≤300ms, the landing-spot feedback still reads, and `vp check` / `vp test` pass.
