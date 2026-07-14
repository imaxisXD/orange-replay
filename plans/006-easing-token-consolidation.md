# 006 — Tokenize the strong ease-out curve and collapse near-duplicate hover durations

- **Status**: DONE
- **Commit**: f1c855f
- **Severity**: MEDIUM-LOW
- **Category**: Cohesion & tokens
- **Estimated scope**: 2 files (dashboard index.css, landing index.html), ~8 edits

## Problem

**(a)** The product's one signature curve, `cubic-bezier(0.22, 1, 0.36, 1)` (a strong ease-out), is hand-typed in five places with no token behind it — three in the dashboard, three in the landing page's own stylesheet:

```css
/* apps/dashboard/src/index.css:544-546 — current */
.stage-in {
  animation: stage-in 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
```

```css
/* apps/dashboard/src/index.css:548-552 — current */
.watched-dot {
  transition:
    opacity 200ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
```

```css
/* landing/index.html:1741 — current */
.lv-page.roll-in {
  animation: lv-rollin 260ms cubic-bezier(0.22, 1, 0.36, 1);
}
```

```css
/* landing/index.html:1771-1772 — current (inside .lv-odo .reel.min-tens) */
transition: max-width 0.32s cubic-bezier(0.22, 1, 0.36, 1);
```

```css
/* landing/index.html:2328-2334 — current (the .reveal scroll-entrance block) */
.reveal {
  opacity: 0;
  transform: translateY(20px);
  transition:
    opacity 0.8s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.8s cubic-bezier(0.22, 1, 0.36, 1);
}
```

**(b)** The dashboard uses three nearly identical durations for the same hover/reveal job: 140ms (hand-written CSS), 150ms (`duration-150`, 7 uses), 160ms. The 160ms group in `scroll-area.tsx` is **deliberate and documented** (comment at `scroll-area.tsx:106-110`: "160ms in, 120ms out (exits faster…)") — leave it. The 140ms stragglers should join the 150ms majority:

```css
/* apps/dashboard/src/index.css:405 — current (.lit::after) */
transition: opacity 140ms ease;
```

```css
/* apps/dashboard/src/index.css:467-469 — current */
.demo-cta {
  transition: box-shadow 140ms ease;
}
```

## Target

**(a)** One token per stylesheet scope. Dashboard: define it in the Tailwind v4 `@theme inline` block in `apps/dashboard/src/index.css` (the block starting at line 282) so it's both a CSS var and a Tailwind `ease-out-strong` utility:

```css
/* target — add inside @theme inline, next to the other design tokens */
--ease-out-strong: cubic-bezier(0.22, 1, 0.36, 1);
```

Then replace the three dashboard occurrences:

```css
/* target */
.stage-in {
  animation: stage-in 200ms var(--ease-out-strong);
}
.watched-dot {
  transition:
    opacity 200ms var(--ease-out-strong),
    transform 200ms var(--ease-out-strong);
}
```

Landing is a self-contained static file — give it its own var in its `:root` block (find the existing `:root { ... }` near the top of the `<style>` element and add the same declaration):

```css
/* target — landing :root */
--ease-out-strong: cubic-bezier(0.22, 1, 0.36, 1);
```

and replace the three landing occurrences (`index.html:1741`, `:1772`, and the two transition lines at `:2332-2333`) with `var(--ease-out-strong)`. The landing `:root` block starts at `index.html:69`. Durations there (260ms, 0.32s, 0.8s) stay exactly as they are — marketing pages may run longer.

**(b)** In `apps/dashboard/src/index.css`, change both `140ms` values (lines 405 and 468) to `150ms`, matching the `duration-150` majority. Keep the `ease` keyword — hover/color transitions correctly use plain `ease`.

Do NOT re-time the 200ms CSS settles or the 160ms spring (`spring.moderate`) to match each other: the 200ms storyboard values are documented at `index.css:526-531` and the scroll-area 160/120 pair is documented in-component — both are settled decisions.

## Repo conventions to follow

- Dashboard design tokens live in the `@theme inline` block of `apps/dashboard/src/index.css` (see `--radius-sm` etc. around line 320) — the easing token belongs there, making `ease-out-strong` available as a Tailwind utility for future use.
- Landing (`landing/index.html`) shares no CSS with the dashboard; duplicate the token there rather than importing anything.
- `landing/index.html` and `design-final.html` look similar — `design-final.html` is the untouchable visual-authority mock. Only edit `landing/index.html`.

## Steps

1. Add `--ease-out-strong: cubic-bezier(0.22, 1, 0.36, 1);` to the `@theme inline` block in `apps/dashboard/src/index.css`.
2. Replace the hand-typed curve with `var(--ease-out-strong)` at `index.css:545` and `index.css:550-551`.
3. Change `140ms` → `150ms` at `index.css:405` and `index.css:468`.
4. In `landing/index.html`, add `--ease-out-strong: cubic-bezier(0.22, 1, 0.36, 1);` to the `:root` custom-property block.
5. Replace the hand-typed curve with `var(--ease-out-strong)` at `landing/index.html:1741`, `:1772`, and `:2332-2333`.

## Boundaries

- Do NOT touch `design-final.html` (repo rule: never modify).
- Do NOT change any duration except the two 140ms → 150ms edits; do NOT touch `scroll-area.tsx`, `springs.ts`, or the 200ms storyboard values.
- Do NOT rename or "improve" the curve's control points — token only, byte-identical values.
- If the code at the cited lines doesn't match the excerpts (drift since commit f1c855f), STOP and report instead of improvising.

## Verification

- **Mechanical**: `vp check` and `vp test` — both pass. Then `grep -rn 'cubic-bezier(0.22, 1, 0.36, 1)' apps/dashboard/src landing/index.html` should only match the two token definitions.
- **Feel check**: nothing should feel different — this is consolidation. Spot-check: select a session card (stage-in rise identical), watch a card's amber dot fade, hover a `.lit` card (border bloom), and on the landing page watch the live-feed page roll and scroll-reveal. All identical to before.
- **Done when**: the grep shows exactly two definitions and zero inline uses, motion is visually unchanged, and `vp check` / `vp test` pass.
