# 007 — Animate full transform strings on the replay-surface popovers

- **Status**: DONE
- **Commit**: f1c855f
- **Severity**: LOW
- **Category**: Performance
- **Estimated scope**: 3 files, mechanical value rewrites

## Problem

Framer Motion's `x`/`y`/`scale`/`scaleY` shorthands are independent transforms animated on the main thread — they are not hardware-accelerated. Animating the full `transform` string lets the engine hand the animation to the compositor. These three components render on the session-replay surface, where playback churns the DOM with recorded mutations, so main-thread animation frames compete with real work:

```tsx
// apps/dashboard/src/components/ui/tooltip.tsx:166-169 — current
                initial={{ opacity: 0, ...slideOffset }}
                animate={{ opacity: 1, x: 0, y: 0 }}
                exit={{ opacity: 0, ...slideOffset }}
                transition={open ? spring.fast : spring.fast.exit}
```

where `slideOffset` comes from `getSlideOffset` (`tooltip.tsx:99-110`) and is `{ y: 4 }` / `{ y: -4 }` / `{ x: 4 }` / `{ x: -4 }` by side.

```tsx
// apps/dashboard/src/components/ui/select.tsx:330-331 — current
            initial={{ opacity: 0, y: -4, scaleY: 0.96 }}
            animate={open ? { opacity: 1, y: 0, scaleY: 1 } : { opacity: 0, y: -4, scaleY: 0.96 }}
```

```tsx
// apps/dashboard/src/components/ui/icon-swap.tsx:31-33 — current
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: "blur(4px)" }}
```

## Target

Identical motion, expressed as `transform` strings.

**Reduced-motion requirement (verified against framer-motion 12.42.2 source, not optional):** `MotionConfig reducedMotion="user"` only disables animations for keys in framer's `positionalKeys` set (`width`/`height`/`top`/`left`/`right`/`bottom` + shorthand transforms like `x`/`y`/`scale`). The literal `transform` key is NOT in that set, so a bare conversion would make tooltip and select movement leak through under `prefers-reduced-motion`. Therefore tooltip.tsx and select.tsx MUST add a manual `useReducedMotion()` branch (the exact pattern `icon-swap.tsx` already uses) as part of this plan.

**tooltip.tsx** — change `getSlideOffset` to return transform strings, add the reduce branch, and update the motion props:

```tsx
// target — tooltip.tsx (amended post-execution: the animate target must be
// axis-matched per side; a fixed "translateY(0px)" target coerces left/right
// tooltips onto the Y axis in Motion 12.42.2)
function getSlideOffset(side: TooltipSide) {
  switch (side) {
    case "top":
      return { from: "translateY(4px)", to: "translateY(0px)" };
    case "bottom":
      return { from: "translateY(-4px)", to: "translateY(0px)" };
    case "left":
      return { from: "translateX(4px)", to: "translateX(0px)" };
    case "right":
      return { from: "translateX(-4px)", to: "translateX(0px)" };
  }
}
```

```tsx
// target — tooltip.tsx, inside the Tooltip component body (after the useShape() call):
const reduce = useReducedMotion();
```

```tsx
// target — tooltip.tsx motion props (slideOffset is now a {from, to} pair)
                initial={reduce ? { opacity: 0 } : { opacity: 0, transform: slideOffset.from }}
                animate={reduce ? { opacity: 1 } : { opacity: 1, transform: slideOffset.to }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, transform: slideOffset.from }}
```

Add `useReducedMotion` to the existing `@/lib/motion` import.

**select.tsx** — popup entrance/exit, same treatment. Add `useReducedMotion` to the `@/lib/motion` import, add `const reduce = useReducedMotion();` inside the component that renders this `m.div`, then:

```tsx
// target — select.tsx:330-331
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(-4px) scaleY(0.96)" }}
            animate={
              open
                ? reduce
                  ? { opacity: 1 }
                  : { opacity: 1, transform: "translateY(0px) scaleY(1)" }
                : reduce
                  ? { opacity: 0 }
                  : { opacity: 0, transform: "translateY(-4px) scaleY(0.96)" }
            }
```

This matches current reduced-motion behavior exactly: today MotionConfig strips `y`/`scaleY` (positional keys) and leaves opacity; the branch reproduces that by hand.

**icon-swap.tsx** — glyph cross-fade:

```tsx
// target — icon-swap.tsx:31-33
          initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "scale(0.25)", filter: "blur(4px)" }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, transform: "scale(1)", filter: "blur(0px)" }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, transform: "scale(0.25)", filter: "blur(4px)" }}
```

## Repo conventions to follow

- All three files import `m` from `@/lib/motion` and springs from `@/lib/springs` — transitions stay untouched.
- `<MotionConfig reducedMotion="user">` (`apps/dashboard/src/lib/motion-provider.tsx:7`) does NOT gate `transform`-string values (verified in framer-motion 12.42.2: only `positionalKeys` are disabled) — hence the mandatory `useReducedMotion()` branches above.
- The hand-branching exemplar is `apps/dashboard/src/components/ui/icon-swap.tsx:23,31-34` — copy its shape. Preserve icon-swap's existing structure exactly when converting its values.

## Steps

1. In `tooltip.tsx`, rewrite `getSlideOffset` to return the strings above, add `useReducedMotion` to the `@/lib/motion` import, add the `reduce` const in the component body, and update the three motion props at lines 166-168 with the branched version (note `slideOffset` is now a string, not an object to spread).
2. In `select.tsx`, add `useReducedMotion` to the `@/lib/motion` import, add the `reduce` const in the component rendering the popup `m.div`, and rewrite `initial`/`animate` at lines 330-331 with the branched version. Do not touch `transition`, `style` (transform-origin), or `onAnimationComplete`.
3. In `icon-swap.tsx`, rewrite the three props at lines 31-33 as above. Do not touch the `transition` line or the doc comment's meaning (update the comment's "scale 0.25→1" phrasing only if it becomes inaccurate — it doesn't; values are identical).

## Boundaries

- Do NOT change any timing, spring token, opacity, or blur value — this is a representation change only.
- Do NOT convert `login.tsx` or `settings-editor.tsx` (not busy surfaces; out of scope).
- Do NOT add new dependencies.
- If the code at the cited lines doesn't match the excerpts (drift since commit f1c855f), STOP and report instead of improvising.

## Verification

- **Mechanical**: `vp check` and `vp test` — both pass.
- **Feel check** (required — this plan has two real risks: reduced-motion gating and interpolation):
  - Tooltips on all four sides (replay controls use side variations): each slides in from its side exactly as before, at DevTools 10% speed no diagonal or popping motion.
  - Select popup: opens/closes identically, including the collision-flipped (upward) placement.
  - Copy→check icon swap on the session-detail machine-id chip: identical blur/scale cross-fade.
  - DevTools → Rendering → emulate `prefers-reduced-motion: reduce`: tooltip and select must NOT slide/scale (opacity-only fade), matching current behavior. This is now guaranteed by the explicit `reduce` branches — confirm they were actually added.
  - Optional but recommended: Performance panel recording while a busy replay plays and a tooltip opens — the tooltip animation should no longer contribute main-thread animation frames.
- **Done when**: motion is visually identical, reduced-motion behavior is unchanged, and `vp check` / `vp test` pass.
