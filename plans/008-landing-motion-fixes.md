# 008 — Landing page: guard the CTA hover rotation and fix the roll-out easing

- **Status**: DONE
- **Commit**: f1c855f
- **Severity**: LOW
- **Category**: Accessibility + Easing & duration
- **Estimated scope**: 1 file, 2 edits

## Problem

**(a) Ungated hover transform on touch.** The primary landing CTA rotates its arrow on `:hover`. On touch devices a tap fires a sticky synthetic hover, leaving the arrow stuck at 45° after the tap. There is no `@media (hover: hover)` guard anywhere in `landing/index.html`. (The dashboard's equivalent `group-hover:rotate-45` in `app-shell.tsx` is already safe — Tailwind v4 gates `hover:` variants behind `(hover: hover)` by default — so the landing page is the only exposure.)

```css
/* landing/index.html:271-276 — current */
.cta-pill .circ .huge-icon {
  transition: transform 200ms ease-out;
}
.cta-pill:hover .circ .huge-icon {
  transform: rotate(45deg);
}
```

**(b) `ease-in` on an exit.** The live-feed "page navigates" roll-out animates with `ease-in`. Exits use ease-out; `ease-in` on UI is always a finding.

```css
/* landing/index.html:1737-1739 — current */
.lv-page.roll-out {
  animation: lv-rollout 200ms ease-in forwards;
}
```

Other hover transitions on the landing page (box-shadow, color, background) are non-transform and stay ungated — only the rotate moves.

## Target

**(a)** Gate the hover rule (the base transition line can stay where it is):

```css
/* target */
.cta-pill .circ .huge-icon {
  transition: transform 200ms ease-out;
}
@media (hover: hover) and (pointer: fine) {
  .cta-pill:hover .circ .huge-icon {
    transform: rotate(45deg);
  }
}
```

**(b)** Exit gets ease-out:

```css
/* target */
.lv-page.roll-out {
  animation: lv-rollout 200ms ease-out forwards;
}
```

## Repo conventions to follow

- `landing/index.html` is a self-contained static page — all CSS lives in its single `<style>` block; edit in place, match its 6-space indentation.
- Copy voice / visual authority rules don't apply here (no copy or layout changes) — but `design-final.html` in the repo root looks similar and must NOT be touched.
- If plan 006 has already run, the `.roll-in` sibling will reference `var(--ease-out-strong)`; that's fine — `.roll-out` keeps the plain `ease-out` keyword (a 200ms disappearing element doesn't need the strong curve).

## Steps

1. In `landing/index.html`, wrap the `.cta-pill:hover .circ .huge-icon` rule (lines ~274-276) in `@media (hover: hover) and (pointer: fine) { … }`.
2. In `landing/index.html:1738`, change `ease-in` to `ease-out`.

## Boundaries

- Do NOT touch `design-final.html`.
- Do NOT gate non-transform hovers (`.cta-pill:hover` box-shadow at line ~266, link colors, tile backgrounds).
- Do NOT change the `lv-rollout` keyframes, durations, or the JS that toggles `.roll-out`/`.roll-in`.
- If the code at the cited lines doesn't match the excerpts (drift since commit f1c855f), STOP and report instead of improvising.

## Verification

- **Mechanical**: `vp check` if the landing page is covered by it; otherwise open `landing/index.html` in a browser and confirm no CSS parse errors in the console.
- **Feel check**:
  - Desktop: hovering the "Start free" CTA still rotates the arrow ↗ → →.
  - DevTools device emulation (touch): tapping the CTA must NOT leave the arrow rotated.
  - Watch the live-feed demo panel until a session navigates: the old page label now leaves starting fast (ease-out) instead of hesitating, and the new label's roll-in still overlaps naturally.
- **Done when**: touch taps leave no stuck hover state, the roll-out uses ease-out, and desktop hover behavior is unchanged.
