# 002 — Anchor the select popup's transform-origin to its trigger; fix checkmark exit easing

- **Status**: DONE
- **Commit**: f1c855f
- **Severity**: MEDIUM
- **Category**: Physicality & origin (+ Easing & duration)
- **Estimated scope**: 1 file, 2 small edits

## Problem

Two findings, both in `apps/dashboard/src/components/ui/select.tsx`.

**(a) Hardcoded transform-origin.** The select popup scales in (`scaleY 0.96→1`) and uses Base UI's positioned popup (`side="bottom" align="start"`), which collision-flips to open _above_ the trigger when there is no room below. When flipped, the popup should scale from its bottom edge where the trigger sits. A hardcoded `"top center"` origin makes it scale from the wrong edge and visually detach from the trigger; `align="start"` also means the anchored corner is the left edge, not center.

```tsx
// apps/dashboard/src/components/ui/select.tsx:329-333 — current
          <m.div
            initial={{ opacity: 0, y: -4, scaleY: 0.96 }}
            animate={open ? { opacity: 1, y: 0, scaleY: 1 } : { opacity: 0, y: -4, scaleY: 0.96 }}
            transition={open ? spring.fast : spring.fast.exit}
            style={{ transformOrigin: "top center" }}
```

**(b) `easeIn` on an exit.** The selected-item checkmark retracts its path with `easeIn`. Rule: entering or exiting UI uses ease-out; `ease-in` on UI is always a finding (it back-loads the motion, delaying the visible change).

```tsx
// apps/dashboard/src/components/ui/select.tsx:571-574 — current
                exit={{
                  pathLength: 0,
                  transition: { duration: 0.04, ease: "easeIn" },
                }}
```

## Target

**(a)** Use Base UI's per-placement origin variable. The Positioner sets `--transform-origin` from the final side and alignment after collision handling. The motion wrapper is its direct child, so it can read the inherited variable:

```tsx
// target
            style={{ transformOrigin: "var(--transform-origin)" }}
```

Leave the `y: -4` nudge and the scale values exactly as they are; this plan changes only the origin.

**(b)** Exit easing becomes ease-out; duration unchanged:

```tsx
// target
                exit={{
                  pathLength: 0,
                  transition: { duration: 0.04, ease: "easeOut" },
                }}
```

## Repo conventions to follow

- The popup already uses the spring tokens from `apps/dashboard/src/lib/springs.ts` (`spring.fast` / `spring.fast.exit`) — leave those untouched.
- The entrance side of the same checkmark (`select.tsx:567-570`) already uses `ease: "easeOut"` — the exit should simply match it.
- The trigger-width variable already used in this file is the exemplar for positioned-popup values: `min-w-[var(--anchor-width)]`.

## Steps

1. Change `style={{ transformOrigin: "top center" }}` to `style={{ transformOrigin: "var(--transform-origin)" }}`.
2. In `select.tsx:573`, change `ease: "easeIn"` to `ease: "easeOut"`.

## Boundaries

- Do NOT change the spring configs, `initial`/`animate` values, `sideOffset`, or the popper `side`/`align` props.
- Do NOT touch the proximity-hover overlay, selected-background, or focus-ring `AnimatePresence` blocks elsewhere in this file.
- Do NOT add new dependencies.
- If the code at the cited lines doesn't match the excerpts (drift since commit f1c855f), STOP and report instead of improvising.

## Verification

- **Mechanical**: `vp check` and `vp test` — both pass.
- **Feel check**: run the dashboard, open the sessions route's Sort select:
  - With DevTools Animations panel at 10% speed, opening downward: the popup grows from its **top-left** (the trigger corner), not from center.
  - Scroll/resize so the select is near the bottom of the viewport, forcing a collision flip: the popup opens upward and grows from its **bottom** edge — it must never look like it detaches from the trigger.
  - Change the selected item: the old checkmark retracts starting fast (ease-out), the new one draws in; neither feels like it hesitates before moving.
- **Done when**: both placements scale from the trigger edge, the checkmark exit uses `easeOut`, and `vp check` / `vp test` pass.
