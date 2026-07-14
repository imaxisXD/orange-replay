# 003 — Make the switch thumb respect prefers-reduced-motion

- **Status**: DONE
- **Commit**: f1c855f
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 1 file, ~6 lines

## Problem

The app gates all framer-motion **components** behind `<MotionConfig reducedMotion="user">` (`apps/dashboard/src/lib/motion-provider.tsx:7`), so declarative `animate` props automatically drop movement under `prefers-reduced-motion`. But the switch thumb's primary horizontal travel uses the **imperative** `animate()` function, which does not read that React context. Result under reduced motion: the thumb's vertical press-squish (declarative, `switch.tsx:204-207`) correctly drops, while the main left/right slide still runs a full 160ms spring.

The three ungated calls in `apps/dashboard/src/components/ui/switch.tsx`:

```tsx
// switch.tsx:66 — checked/hover/press position sync
animate(motionX, thumbX, thumbTransition ?? spring.moderate);
```

```tsx
// switch.tsx:122 — drag released without toggling: snap back
animate(motionX, snapTarget, thumbTransition ?? spring.moderate);
```

```tsx
// switch.tsx:141 — drag cancelled by the system: snap back
animate(motionX, snapTarget, thumbTransition ?? spring.moderate);
```

Direct drag-following (`motionX.set(...)` in `handlePointerMove`, `switch.tsx:98`) is direct manipulation, not an animation — it must keep working under reduced motion.

## Target

Branch on `useReducedMotion()`: when reduced, the three `animate()` calls use `{ duration: 0 }` so the thumb snaps to its target instantly. Reduced motion means removing movement, not removing the state change.

```tsx
// target — hook at the top of the component body (after line 29's useId):
const reduceMotion = useReducedMotion();
const thumbSpring: Transition = reduceMotion
  ? { duration: 0 }
  : (thumbTransition ?? spring.moderate);
```

```tsx
// target — each of the three call sites becomes:
animate(motionX, thumbX, thumbSpring); // line 66
animate(motionX, snapTarget, thumbSpring); // line 122
animate(motionX, snapTarget, thumbSpring); // line 141
```

Note: the `useEffect` at lines 61-68 closes over `thumbTransition` in its dependency array — update the dependency to `thumbSpring` (or add `reduceMotion`) so the effect stays correct.

## Repo conventions to follow

- `useReducedMotion` is already re-exported from the repo's motion facade: `import { ... useReducedMotion } from "@/lib/motion";` — extend the existing import at `switch.tsx:4`.
- The hand-branching exemplar is `apps/dashboard/src/components/ui/icon-swap.tsx:23,34`: `const reduce = useReducedMotion();` … `transition={reduce ? { duration: 0 } : ...}`.
- Spring tokens come from `@/lib/springs` (`spring.moderate` = duration 0.16, bounce 0) — already imported; don't redefine values.

## Steps

1. In `switch.tsx:4`, add `useReducedMotion` to the existing `@/lib/motion` import.
2. Inside the component (after the `labelId` declaration at line 29), add the `reduceMotion` hook call and the `thumbSpring` const shown above.
3. Replace `thumbTransition ?? spring.moderate` with `thumbSpring` at lines 66, 122, and 141, and fix the effect dependency array at line 68 accordingly.

## Boundaries

- Do NOT touch the pointer/drag logic, `motionX.set` calls, thumb geometry constants, or the declarative `animate={{ y: thumbY }}` block.
- Do NOT remove the `thumbTransition` prop — callers may still override; reduced motion wins over the override (the ternary above already encodes this).
- Do NOT add new dependencies.
- If the code at the cited lines doesn't match the excerpts (drift since commit f1c855f), STOP and report instead of improvising.

## Verification

- **Mechanical**: `vp check` and `vp test` — both pass.
- **Feel check**: run the dashboard, use the "Unwatched" switch in the sessions rail:
  - Normal mode: toggling springs the thumb across (160ms, no bounce), dragging follows the pointer, releasing mid-track snaps with a spring.
  - DevTools → Rendering → emulate `prefers-reduced-motion: reduce`: toggling **snaps instantly** (no travel animation); dragging still follows the pointer live; releasing snaps instantly. The checked/unchecked state change must remain fully visible.
- **Done when**: under reduced motion no spring animation runs on the thumb while all switch behavior still works, and `vp check` / `vp test` pass.
