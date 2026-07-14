# 004 — Move the tab indicator's travel onto the compositor and fix its easing

- **Status**: DONE
- **Commit**: f1c855f
- **Severity**: MEDIUM
- **Category**: Performance + Easing & duration
- **Estimated scope**: 1 file, 1 className rewrite

## Problem

The Base UI tabs indicator animates four layout-triggering properties (`top`, `left`, `width`, `height`) — every tab switch runs a 200ms layout+paint loop off the compositor. It also uses `ease-out`, but an element _moving_ across the screen (not entering/exiting) should use `ease-in-out`: the indicator is visible before and after, so it should accelerate away and decelerate in.

```tsx
// apps/dashboard/src/components/ui/tabs.tsx:17 — current
<TabsPrimitive.Indicator className="pointer-events-none absolute top-(--active-tab-top) left-(--active-tab-left) h-(--active-tab-height) w-(--active-tab-width) rounded-md bg-card transition-[top,left,width,height] duration-200 ease-out motion-reduce:transition-none" />
```

Base UI sets `--active-tab-top/left/width/height` (px lengths) on the list; the current code consumes them as `top`/`left`/`width`/`height`.

## Target

Position via `transform: translate(...)` (compositor-friendly) instead of `top`/`left`; keep `width`/`height` in the transition list (they still vary between tabs of different label lengths, and a snap would look broken), and switch easing to `ease-in-out`. This moves the dominant motion — the horizontal travel — off the layout pipeline; the remaining width/height interpolation only reflows the absolutely-positioned, `pointer-events-none` indicator itself.

```tsx
// target
<TabsPrimitive.Indicator className="pointer-events-none absolute top-0 left-0 h-(--active-tab-height) w-(--active-tab-width) [transform:translate(var(--active-tab-left),var(--active-tab-top))] rounded-md bg-card transition-[transform,width,height] duration-200 ease-in-out motion-reduce:transition-none" />
```

Why not transform-only (translate + scale): scaling a rounded-rect indicator distorts its corner radius, and the counter-scaled-child workaround needs a width ratio CSS can't reliably compute from the px vars. The hybrid above is the standard, visually-identical fix; do not attempt the scale version.

## Repo conventions to follow

- Tailwind v4 with paren shorthand for var utilities (`h-(--active-tab-height)`) — keep that style; the transform needs the arbitrary-property form `[transform:...]` since there's no var-based translate-x/y pair utility for two lengths.
- `motion-reduce:transition-none` is this file's reduced-motion convention — preserve it.
- The only current consumer is the tab bar in `apps/dashboard/src/routes/overview/overview-breakdowns.tsx` — use it to verify.

## Steps

1. In `apps/dashboard/src/components/ui/tabs.tsx:17`, replace the Indicator's className with the target string above. The exact diffs within the string: `top-(--active-tab-top)` → `top-0`, `left-(--active-tab-left)` → `left-0`, add `[transform:translate(var(--active-tab-left),var(--active-tab-top))]`, `transition-[top,left,width,height]` → `transition-[transform,width,height]`, `ease-out` → `ease-in-out`. Everything else in the className stays.

## Boundaries

- Do NOT touch `TabItem`, `TabPanel`, or the `TabsList` container classes.
- Do NOT change duration (200ms) — it matches the repo's CSS settle timing.
- Do NOT add new dependencies.
- If the code at the cited line doesn't match the excerpt (drift since commit f1c855f), STOP and report instead of improvising.

## Verification

- **Mechanical**: `vp check` and `vp test` — both pass.
- **Feel check**: run the dashboard, open the Overview route's breakdowns card:
  - Click between tabs: the indicator glides exactly as before — same start/end positions, pill snug behind the active label. At DevTools Animations 10% speed, confirm it accelerates out and decelerates in (ease-in-out) rather than starting at max speed.
  - Resize the window; the indicator must stay aligned under the active tab (Base UI recomputes the vars — translate must track them just like top/left did).
  - DevTools → Rendering → "Paint flashing": switching tabs should no longer flash repaints along the indicator's travel path (only at the indicator itself for the width change).
  - Rendering → emulate `prefers-reduced-motion: reduce`: the indicator jumps instantly (transition-none preserved).
- **Done when**: indicator position is transform-driven, easing is ease-in-out, appearance is pixel-identical at rest, and `vp check` / `vp test` pass.
