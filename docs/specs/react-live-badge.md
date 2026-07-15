# React Live Badge

Recreate the landing page's live indicator as reusable dashboard React components. The visual source of truth is `landing/index.html` (`.live-badge`, `.live-dot`, `.live-dot__light`, and the 7x7 light-generation script). Do not modify the landing page or `design-final.html`.

## Scope

- Add a reusable dashboard `LiveDot` with the landing page's default 12px dotted-light treatment and its 7px/6px solid pinlight sizes.
- Add a reusable `LiveBadge` that combines the default dot with the landing page's green mono uppercase "Live now" label.
- Use the full badge in the dashboard Live panel title and the 7px component in each live-session row.
- Preserve the landing page's colors, rim, bloom timing, twinkle timing range, light falloff, and reduced-motion behavior. Add a small scale change to the bloom and pixels so the copied opacity motion remains visible at the dashboard's 12px size.
- Generate the 7x7 light values deterministically so React renders the same markup on every render and can safely hydrate it later.
- Add a focused component test. Do not add a dependency or create a replacement for a registry-provided control.

## File budget

- `apps/dashboard/src/components/live-badge.tsx`
- `apps/dashboard/src/routes/live.tsx`
- `apps/dashboard/src/index.css`
- `apps/dashboard/tests/live-badge.test.tsx`
- `docs/design-language.md`
- `HANDOFF.md`
- this spec

## Definition of done

- The default dot renders a clipped 7x7 grid (49 lights) inside the 12px dark-green face.
- The small dot uses the source's 7px solid pinlight treatment and does not render hidden light cells.
- Motion stops under `prefers-reduced-motion: reduce`.
- `vp check` and `vp test` pass from the repo root.
- The running `/demo/live` page is visually checked at desktop and narrow widths.
