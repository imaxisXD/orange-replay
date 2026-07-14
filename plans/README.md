# Animation improvement plans

Produced by an `improve-animations` audit at commit `f1c855f` (2026-07-12). Each plan is self-contained — an executor needs no other context. Repo quality gates apply to every plan: `vp check` and `vp test` must pass.

## Plans

| #   | Plan                                                                                               | Severity   | Status |
| --- | -------------------------------------------------------------------------------------------------- | ---------- | ------ |
| 001 | [Hard-cut the play/pause glyph swap](001-play-pause-hard-cut.md)                                   | HIGH       | DONE   |
| 002 | [Select popup transform-origin + checkmark exit easing](002-select-popup-origin-and-check-exit.md) | MEDIUM     | DONE   |
| 003 | [Switch thumb respects prefers-reduced-motion](003-switch-reduced-motion.md)                       | MEDIUM     | DONE   |
| 004 | [Tab indicator travel on the compositor, ease-in-out](004-tabs-indicator-transform.md)             | MEDIUM     | DONE   |
| 005 | [Trim timeline playhead flash to ≤300ms](005-playhead-flash-duration.md)                           | MEDIUM-LOW | DONE   |
| 006 | [Tokenize the strong ease-out curve, collapse 140ms→150ms](006-easing-token-consolidation.md)      | MEDIUM-LOW | DONE   |
| 007 | [Full transform strings on replay-surface popovers](007-accelerated-transform-strings.md)          | LOW        | DONE   |
| 008 | [Landing: hover guard + roll-out easing](008-landing-motion-fixes.md)                              | LOW        | DONE   |
| 009 | [Scrollbar thumb thicken via transform](009-scrollbar-thumb-transform.md)                          | LOW        | DONE   |

## Recommended execution order & dependencies

1. **001** first — highest leverage, trivial diff.
2. **002, 003, 004, 005** in any order — independent of each other.
3. **006 after 005** — both edit the motion section of `apps/dashboard/src/index.css`; running 006 last also lets it tokenize the final state. (006 and 008 both touch `landing/index.html` in different blocks; order between them doesn't matter, but don't run them concurrently in one checkout.)
4. **007 after 001 and 002** — 007 edits `icon-swap.tsx` (001 removes one of its call sites) and the same `m.div` in `select.tsx` that 002 touches. 007 also carries the audit's one open risk: verify `MotionConfig reducedMotion="user"` still gates `transform`-string values before shipping.
5. **008, 009** anytime (subject to the 006/008 same-file note above).

## Deliberately not planned (audit notes, do not "fix")

- `.stage-in` keyframe restart on session selection — keyed remount is the intended fresh-content cue; documented storyboard (`index.css:526`).
- `icon-swap.tsx` scale 0.25 + blur values — documented convention for contextual icon swaps.
- Scroll-area 160ms-in/120ms-out visibility timing — documented in-component.
- 200ms CSS settle vs 160ms spring settle — both documented systems.
- Landing odometer `max-width` reveal — the layout change is the point (siblings must shift to make room); rare, marketing-only.
- Replayer cursor `transition: none` under reduced motion (`player-ui.css:15-18`) — replayed content, defensible reading of the preference.
- `app-shell.tsx:182` hover rotate on touch — already gated by Tailwind v4's default `(hover: hover)` hover variant.
