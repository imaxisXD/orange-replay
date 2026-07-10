# Orange Replay design language

Codified from `design-final.html` (the UI visual authority — a static mock at repo root; never modify or reformat it). Every dashboard screen must carry this language. Implemented in `apps/dashboard/src/index.css` (tokens + `.lit`) and the restyled `@fluid` components — reuse those; this doc exists so new screens (sessions/live/detail/settings, T3.4–T3.6) apply the same treatments without reverse-engineering the mock.

## Principles

- **Dark only.** One theme: near-black `#0a0a0c` canvas with a dotted grid. `class="dark"` is permanently on `<html>`; there is no theme toggle.
- **Chrome whispers, data speaks.** Borders/dashes are quiet structure; amber numerals, pills, and heat cells own the eye.
- **Numbers are mono.** Every data numeral: mono stack + `tabular-nums`. Right-align numeric table columns.
- **Nothing fake.** No UI affordances without a real implementation behind them (no dead ⌘K, links, or placeholder tabs).

## Tokens (already wired in `index.css`; Tailwind v4 `@theme`)

| Token                               | Value                                                                                     | Use                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--background`                      | `#0a0a0c`                                                                                 | canvas                                                                                                                    |
| `--card`                            | `#111114`                                                                                 | panels (`.lit` base)                                                                                                      |
| `--secondary` / `--muted` / popover | `#16161a`                                                                                 | inputs, chips, nested surfaces                                                                                            |
| `--border`                          | `#232329`                                                                                 | solid hairlines                                                                                                           |
| `--color-dash`                      | `#2e2e36`                                                                                 | dashed separators                                                                                                         |
| `--foreground`                      | `#ececf1`                                                                                 | text; also primary-button fill                                                                                            |
| `--muted-foreground`                | `#8b8b95`                                                                                 | secondary text; **the floor for body-adjacent text ≤12px** (dim measures ~3.2:1, below WCAG AA — see contrast rule below) |
| `--color-dim`                       | `#62626c`                                                                                 | tertiary LABELS only: table headers, uppercase micro-labels, decorative icons — never sentence-level meta text            |
| `--color-amber`                     | `#f5a623`                                                                                 | THE accent: active tab underline, env badge, warm stat values, playhead, focus rings                                      |
| `--color-teal`                      | `#2dd4bf`                                                                                 | calm/positive data (heat low end, live accents)                                                                           |
| `--color-danger`                    | `#f4534e`                                                                                 | errors                                                                                                                    |
| `--color-success`                   | `#34d399`                                                                                 | ok dots, live pulse                                                                                                       |
| `--radius`                          | 8px                                                                                       | cards/panels                                                                                                              |
| body                                | dotted grid: `radial-gradient(circle,#1b1b21 1px,transparent 1px)` 26px, `font-size:13px` |                                                                                                                           |

Mono stack: `"Uncut Plan8", ui-monospace, "SF Mono", Menlo, monospace`.

## The `.lit` card (signature surface — defined once in `index.css`)

Grain texture + long-dash 1px SVG border (`stroke-dasharray '12 4'`, `stroke-opacity 0.42`) revealed by a **permanent top-left radial bloom** (`radial-gradient(170% 130% at 0% 0%, …)`), brightening on hover (`::after` opacity 0.85 → 1), plus a faint top-left sheen. Apply `.lit rounded-lg` (+ `overflow-hidden` for tables) to every **top-level** card/panel. Rules:

- Never nest `.lit`. Nested boxes: `border border-border rounded-lg bg-secondary`.
- `.lit` kills the element's own border — internal dividers are drawn on children (e.g. `border-b border-dashed border-dash` toolbar edges, `border-r border-dashed border-dash` stat separators).

## Shell

- **Tier-1 nav** (sticky, `rgba(10,10,12,0.85)` + blur, `border-b border-border`, 12px×28px padding): brand mark (24px rounded square, `bg-secondary border-dash`, inner 2.5px teal→amber→red gradient bar — component `src/components/brand-mark.tsx`) · wordmark 14px semibold · `/` in `#33333b` · project switcher (Select: `bg-card border-border rounded-lg` 12.5px) · env badge (amber text on `rgba(245,166,35,0.09)`, 1px _dashed_ `rgba(245,166,35,0.35)`, full-radius pill, 11px) · right: ghost "Log out", decorative teal-gradient avatar.
- **Tier-2 tabs** (same bg, `px-[28px] border-b`): 13px, `text-muted-foreground`, `py-[10px] px-[13px]`, `border-b-2 -mb-px`; active = `text-foreground border-amber font-medium`. Only real routes get tabs.
- **Main**: `max-w-[1200px] mx-auto px-[28px] py-6`.
- **Page header**: title 18px semibold `tracking-[-0.015em]` with inline subtitle `text-[12px] text-dim ml-[10px]`; actions right.

## Icon vocabulary (Hugeicons free set only, via `src/lib/icon-map.tsx` — one family, no exceptions)

Event/signal glyphs are canonical app-wide; never substitute per-screen: **click = `MouseLeftClick06`** (player-blue in timelines, dim for dead clicks) · **rage = `Angry`** (ALWAYS amber — an emotion metric gets an emotion glyph; never a lightning bolt, which reads as "speed") · **error = `AlertCircle`** (danger) · **navigation = `ArrowUpRight`** (teal) · **handheld device = `Smartphone`** (exception signal: desktop shows no glyph). Icons must carry information text can't at scan speed; decorative icons are banned.

## Components

- **Buttons**: default `bg-card border border-border text-[12.5px] font-medium rounded-lg px-[13px] py-[7px]`; **primary = light-filled** (`bg-foreground text-background font-semibold`) — never amber-filled; ghost = borderless muted → foreground on hover. Focus rings amber.
- **Status pills** (`src/components/status-pill.tsx` — single source of truth): full-radius, 11px medium, 6px dot, tinted 1px borders. `ok` (border-border, muted text, green dot) · `err` (`#ffb3b0` on `rgba(244,83,78,0.07)`, border `rgba(244,83,78,0.35)`, red dot) · `rage` (`#ffd9a0` on `rgba(245,166,35,0.07)`, border `rgba(245,166,35,0.35)`, amber dot) · `neutral` chip (no dot). Copy: "1 error"/"N errors" (pluralize), "N rage" (never pluralized). **Signal rule (2026-07-10): pills render only when there is something to say — healthy rows show no pill.** ("clean" was retired; absence is the signal.)
- **Table**: `th` 11px uppercase `tracking-[0.06em] text-dim` medium, `border-b border-border`; `td` `px-4 py-3 border-b border-[#1a1a1f]` (last row borderless), hover `bg-[#141419]`; numerals `font-mono text-[12px]` muted (emphasized: foreground). Primary cell = 13px medium path + meta line `text-[11.5px] text-dim` (`{flag} {city} · {n} clicks`). Rows navigate: `role="link"` + keyboard + hover chevron in a 24px end gutter.
- **Formats** (`src/lib/format.ts`): durations `m:ss` / `h:mm:ss` (`10:12`, `0:22`); bytes compact `512K`, `1.1M` (one decimal < 10M); relative times short (`48m`, `2h`) with full timestamp in `title`.
- **Inputs / input-group**: `bg-secondary border-border rounded-[7px]` 12px, placeholder dim, amber focus ring. Selects/tooltips: popover surface + border. Switch: amber when on. Skeleton: `bg-secondary`. Empty states: `border-dashed border-dash` box.
- **Stat strip** (see mock + session-detail): `.lit` flex row; cells `flex-1 px-[18px] py-[15px] border-r border-dashed border-dash`; label 11.5px muted; value 21px mono semibold `tracking-[-0.02em]`, **amber when it's a nonzero warning count** (errors, rages).

## Mock patterns not yet built (for T3.4/T3.5 — match the mock exactly when implementing)

- **Live rail** (`Live now` panel): rows separated by dashed lines; pulsing 7px green dot (`@keyframes` 1.8s opacity 0.25); page path 12.5px, location line 11.5px dim, mono elapsed right; "N watching" teal chip with dashed teal border.
- **Friction heatmap**: 14px cells, 4px gap, `rounded-[4px]`; empty `#17171c`; teal ramp `#113732 → #14746a → #2dd4bf`, amber ramp `#4a3410 → #b97a09 → #f5a623`, red ramp `#4c1a18 → #b3312d → #f4534e` (peak red gets a glow); teal→amber→red gradient legend bar.
- **Player bar**: `.lit` row — 32px light play button; mono timecodes; timeline with dashed baseline, 4px activity ticks `#2e2e38`, 2px red error markers with glow, amber playhead (2px + 8px dot + glow); `kbd` hints (mono 10.5px, `bg-secondary border-border`).
- **Activity sparklines** (built 2026-07-10, `src/components/activity-spark.tsx`, fed by the `activity_hist` D1 column): 84×16px, 8 bars, 1.5px gap; bar color `#2e2e38` — deliberately the player scrubber's tick color so list and player share one activity vocabulary (supersedes the earlier `#26262d`) — with `#f4534e` error buckets; no-data renders a 2px `#17171c` baseline, never fake bars.
- **Sessions triage layout** (2026-07-10): the sessions route is a two-pane view — 320px `.lit` card rail (sort + session cards) + inline replay stage — and uses a wide main container (`max-w-475`); all other routes keep `max-w-300`. Cards: amber unwatched dot (fades on watch), entry path + mono duration, err/rage pills + sparkline, muted-foreground meta line. Selection pushes history; filters replace.
