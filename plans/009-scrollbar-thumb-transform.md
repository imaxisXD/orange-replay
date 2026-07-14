# 009 — Thicken the scrollbar thumb with transform instead of width/height

- **Status**: DONE
- **Severity**: LOW
- **Commit**: f1c855f
- **Category**: Performance
- **Estimated scope**: 1 file, 1 className block

## Problem

The scroll-area thumb thickens on scrollbar hover by animating `width` (vertical) / `height` (horizontal) — layout properties, animated off-GPU. Scroll areas wrap the busiest surfaces in the app (session rail, replay timeline sidebar), where replay playback already loads the main thread.

```tsx
// apps/dashboard/src/components/ui/scroll-area.tsx:129-140 — current
<ScrollAreaPrimitive.Thumb
  data-slot="scroll-area-thumb"
  className={cn(
    "relative bg-foreground/25 transition-[background-color,width,height] duration-160 ease-in-out",
    "group-hover/scrollbar:bg-foreground/45 active:!bg-foreground/60",
    shape.bg,
    orientation === "vertical" &&
      "mx-auto my-1 w-1 h-[var(--scroll-area-thumb-height)] group-hover/scrollbar:w-1.5",
    orientation === "horizontal" &&
      "my-auto mx-1 h-1 w-[var(--scroll-area-thumb-width)] group-hover/scrollbar:h-1.5",
  )}
/>
```

Resting thickness is 4px (`w-1`/`h-1`), hover is 6px (`w-1.5`/`h-1.5`). The thumb's _length_ (`--scroll-area-thumb-height`/`-width`) is set by Base UI and is not part of the hover animation — it must keep working.

## Target

Render the thumb at its hover thickness (6px) and scale the thickness axis down to 4/6 ≈ 0.667 at rest, releasing to 1 on hover. Only `transform` and `background-color` animate. The thumb is centered on its axis (`mx-auto`/`my-auto`), so the default center transform-origin is correct.

```tsx
// target
<ScrollAreaPrimitive.Thumb
  data-slot="scroll-area-thumb"
  className={cn(
    "relative bg-foreground/25 transition-[background-color,scale] duration-160 ease-in-out",
    "group-hover/scrollbar:bg-foreground/45 active:!bg-foreground/60",
    shape.bg,
    orientation === "vertical" &&
      "mx-auto my-1 w-1.5 scale-x-[0.667] h-[var(--scroll-area-thumb-height)] group-hover/scrollbar:scale-x-100",
    orientation === "horizontal" &&
      "my-auto mx-1 h-1.5 scale-y-[0.667] w-[var(--scroll-area-thumb-width)] group-hover/scrollbar:scale-y-100",
  )}
/>
```

Note on radius: `shape.bg` gives the thumb a pill radius; at scale 0.667 on a 6px-thick pill the radius distortion is sub-pixel and imperceptible — do not add counter-scale machinery.

Note on `width`/`height` remaining in the classes: the Base UI thumb-length var still sets length, but length was never transitioned smoothly anyway (`width`/`height` leave the transition list, so length updates now snap — same as the previous behavior in practice, since length only changes with content size).

## Repo conventions to follow

- This is a vendored Fluid Functionalism registry component — keep the edit minimal and preserve the surrounding comments (the 160ms-in/120ms-out visibility timing at lines 106-110 is documented and deliberate; do not touch the Scrollbar element).
- Tailwind v4 arbitrary values (`scale-x-[0.667]`) match the file's existing style (`h-[var(--scroll-area-thumb-height)]`).

## Steps

1. In `apps/dashboard/src/components/ui/scroll-area.tsx:129-140`, replace the Thumb `className` block with the target above. Exact changes: transition list `[background-color,width,height]` → `[background-color,scale]` (amended post-execution: Tailwind v4 compiles `scale-x-*`/`scale-y-*` to the standalone CSS `scale` property, not `transform`, so `scale` must be the transitioned property); vertical: `w-1` → `w-1.5 scale-x-[0.667]`, `group-hover/scrollbar:w-1.5` → `group-hover/scrollbar:scale-x-100`; horizontal: `h-1` → `h-1.5 scale-y-[0.667]`, `group-hover/scrollbar:h-1.5` → `group-hover/scrollbar:scale-y-100`.

## Boundaries

- Do NOT touch the Scrollbar wrapper (opacity/delay logic), the track hit-target sizing, or Base UI's thumb-length vars.
- Do NOT change colors, durations, or the `ease-in-out` easing (thickness change is a morph — ease-in-out is correct).
- Do NOT add new dependencies.
- If the code at the cited lines doesn't match the excerpt (drift since commit f1c855f), STOP and report instead of improvising.

## Verification

- **Mechanical**: `vp check` and `vp test` — both pass.
- **Feel check**: run the dashboard, scroll the session rail:
  - Thumb rests at the same 4px visual thickness as before (compare against a git-stashed run or the sessions rail screenshot in `design-final.html` if unsure).
  - Hovering the scrollbar grows the thumb smoothly to 6px; leaving shrinks it back; the grow must be centered (no one-sided growth).
  - The thumb still tracks and resizes correctly when the list length changes (filter with the Unwatched switch).
  - At DevTools 10% speed, the pill's rounded ends must not look visibly squashed at rest.
- **Done when**: hover thicken is transform-driven, resting/hover thicknesses match the previous 4px/6px, and `vp check` / `vp test` pass.
