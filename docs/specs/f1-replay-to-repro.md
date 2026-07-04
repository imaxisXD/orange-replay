# F1 — Replay-to-Repro: from a session to a failing Playwright test

## Goal (what exists when this ships)

On any finalized session's detail page, a **"Repro" button** opens a panel with three copyable artifacts, generated **entirely client-side** (no server call — the viewer's browser already holds the decoded events; this preserves our no-server-inspection privacy stance):

1. **A runnable Playwright spec** that replays the user's exact path and asserts the recorded page error does NOT occur — i.e. a regression test that is RED while the bug exists and GREEN once fixed.
2. **A failure bundle** (versioned JSON): structured steps, selectors, error signatures, DOM context at failure — machine-consumable by coding agents.
3. **A markdown bug report** rendered from the bundle for humans/issue trackers.

Result demo (acceptance): record a session on the demo site clicking "Trigger TypeError"; open its detail page; click Repro; paste the generated spec into `fixtures/demo-site/tests/`; `npx playwright test` runs it; the test FAILS with the recorded TypeError signature (because the bug "exists"); commenting out the demo's throw makes it PASS.

## Architecture

New module family `packages/player/src/repro/` — **pure functions, zero imports from rrweb, zero DOM API usage** (no `document`/`window`). This is a hard requirement: the future MCP server (spec F2) runs these same functions in Node. Everything operates on plain decoded event JSON (`ReplayEvent`) + the manifest (`SessionManifest` from shared).

Files:

- `repro/virtual-dom.ts` — `VirtualDomIndex`
- `repro/selector.ts` — selector builder
- `repro/steps.ts` — event stream → abstract step list
- `repro/playwright.ts` — steps → Playwright TypeScript source
- `repro/bundle.ts` — steps + errors + DOM context → bundle JSON + markdown
- `repro/index.ts` — public API: `buildRepro(events, manifest, options) => { script, bundle, markdown }`
- re-export from `packages/player/src/index.ts`

## 1. VirtualDomIndex (`virtual-dom.ts`)

Maintains `id → SerializedNode` from the rrweb stream so interaction events (which carry only node ids) can be resolved to selectors.

- Input event shapes (rrweb 2.x, verify against `node_modules/rrweb/dist/rrweb.d.ts` and `@rrweb/types` — do NOT guess):
  - FullSnapshot (`type === 2`): `data.node` is the serialized document tree; walk it recursively registering every element node: `{ id, tagName, attributes: Record<string,string>, parentId, childIds, textContent? }` (text = concatenated child text nodes, capped 120 chars).
  - IncrementalSnapshot (`type === 3`) with `data.source === IncrementalSource.Mutation (0)`: apply `adds` (register, parent linkage), `removes` (unregister subtree), `attributes` (merge patches), `texts` (update).
  - A new FullSnapshot RESETS the index (rrweb re-serializes with fresh ids after checkpoints).
- API: `applyEvent(event)`, `resolve(id): SerializedNode | null`, `ancestorChain(id, max=5): SerializedNode[]`.
- Bounded: cap registry at 200k nodes; past that, evict nothing but set `overflowed=true` (surface as a bundle warning).

## 2. Selector builder (`selector.ts`)

`buildLocator(node, index): { locator: string; strategy: string; ambiguous: boolean }` — emits a **Playwright locator expression** using this preference ladder (first match wins):

1. `data-testid` → `page.getByTestId("...")`
2. Stable `id` → `page.locator("#id")` — REJECT generated-looking ids (regex: contains ≥4 consecutive digits, or matches `/^(ember|radix|react|:r)/i`, or length > 24)
3. `aria-label` → `page.getByLabel("...")`
4. `role` + short accessible text (≤30 chars, from textContent) → `page.getByRole("button", { name: "..." })` (role from explicit attr, else tag→role map for button/a/input/select/textarea only)
5. Short unique-ish text (≤30 chars, element is a/button/label/summary) → `page.getByText("...", { exact: true })`
6. Fallback: CSS path from the ancestor chain: `tag[stable-attrs] > tag:nth-of-type(n)` — max 4 segments, nth-of-type computed from sibling childIds in the index.

Text containing `*` (rrweb mask char) or `[blocked]` must never appear in a selector — skip to the next strategy. Escape quotes. Strategies 5–6 set `ambiguous: true` → codegen appends `.first()` plus a `// NOTE: verify selector` comment.

## 3. Steps (`steps.ts`)

`extractSteps(events, manifest): ReproStep[]` — walk events sorted by timestamp, feeding VirtualDomIndex, and emit:

- `{ kind: "viewport", width, height, t }` from the first Meta (`type 4`).
- `{ kind: "goto", url, t }` from the first Meta `href` (already scrubbed by the SDK — document in the output that query params are stripped unless allowlisted).
- `{ kind: "navigate", url, t }` for subsequent Meta events / manifest `nav` index events (dedupe within 500ms).
- `{ kind: "click", locator, strategy, ambiguous, t }` from IncrementalSnapshot `source === MouseInteraction (2)` with `data.type === Click` (verify enum value in rrweb types) → resolve `data.id`.
- `{ kind: "fill", locator, masked: true, t }` from `source === Input (5)`: values are masked at capture — NEVER emit recorded text; group consecutive Input events on the same id into one step.
- `{ kind: "scroll", y, t }` from `source === Scroll (3)` on the document node only, and only if the next click's node was registered after the scroll (i.e. scrolling mattered); otherwise drop.
- `{ kind: "wait", ms, t }` for gaps > 2000ms between consecutive steps (informational; codegen renders as comment, not sleep).
- `{ kind: "error", message, t }` from manifest timeline `k === "error"` entries (detail is the truncated message).
- Steps AFTER the last error + 1s are trimmed (the repro ends at failure); if no errors, keep the full path.

## 4. Codegen (`playwright.ts`)

`renderPlaywright(steps, meta): string` — emits a complete, formatted `.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

// Generated by Orange Replay from session <id> (<browser> · <os>, <viewport>).
// Recorded input values are masked; TEST_VALUE placeholders need real data.
test("reproduces: <first error message, 60 chars>", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: W, height: H });
  await page.goto("<BASE_URL>" + "<path>"); // origin stripped at capture — set BASE_URL
  await page.getByRole("button", { name: "Add product row" }).click();
  await page.locator("#workspace").fill("TEST_VALUE"); // masked in recording
  // waited ~4s here in the original session
  ...
  // The recorded session hit: "<error message>"
  // This assertion FAILS while the bug exists and PASSES once fixed.
  expect(pageErrors.filter(e => e.includes("<error signature>"))).toHaveLength(0);
});
```

Error signature = first 80 chars of the error detail with numbers/hex/uuids replaced by `*` (stability against dynamic content), matched with `includes` on the normalized form (normalize collected errors the same way). No error in session → final assertion block replaced by `expect(pageErrors).toHaveLength(0)`.

## 5. Bundle (`bundle.ts`)

`buildBundle(steps, manifest, index): ReproBundle` — versioned (`v: 1`) JSON:

```
{ v: 1, session: { id, startedAt, durationMs, browser, os, viewport, entryUrl },
  steps: [...],                       // the ReproStep list verbatim
  errors: [{ t, message, signature }],
  domContext: {                       // at the last error, else last step
    target: SerializedNode,           // last interacted node
    ancestors: SerializedNode[],      // ≤5, attributes only — never innerHTML
  },
  warnings: ["inputs masked", "urls query-stripped", "index overflowed"?, "multi-tab session: dominant tab only"?],
  generator: { name: "orange-replay", schema: "repro-bundle/1" } }
```

`renderMarkdown(bundle): string` — sections: What happened / Steps to reproduce (numbered) / Error / Environment / Notes (warnings). ≤4KB.

## 6. Dashboard UI (`apps/dashboard`)

- Ghost button "Repro" with a code icon in the session-detail breadcrumb row (right, before "Refresh manifest"), per docs/design-language.md. Hidden while `mode === "live"` or manifest missing.
- Click → slide-over panel (a `.lit` panel, right side, 560px): tabs **Test / Bundle / Report** (existing tabs component conventions — no new registry pulls), each a mono `bg-secondary` code block with the copy-icon-button (1.5s check swap, like session-id copy). Footer note: "Generated locally in your browser — nothing was sent to a server."
- Multi-tab sessions: generate from the tab with the most events; show the warning chip.
- Generation input: the player already holds decoded events — expose `getDecodedEvents(): ReplayEvent[]` on OrangePlayer (new public method returning the internal `events` array copy) so the dashboard passes them + manifest into `buildRepro`.

## Tests (all pure-function, happy-dom/node — heavy coverage expected)

- virtual-dom: fullsnapshot walk registers ids/attrs/text; mutations add/remove/attr/text; fullsnapshot resets; overflow flag.
- selector ladder: one fixture node per strategy, generated-id rejection, mask-char rejection, ambiguity flag, quote escaping.
- steps: click/fill grouping/nav dedupe/gap-waits/trim-after-error; masked fill never carries text.
- codegen golden tests: fixture stream → exact expected script (inline snapshot).
- bundle schema + markdown golden.
- Integration: build a fixture stream mirroring the demo site's TypeError flow and assert the generated script contains the goto, the button click by role, and the failing assertion with the normalized signature.

## Constraints & DoD

No new runtime deps. No worker/API changes. No rrweb import inside `repro/` (enforce: add an oxlint no-restricted-imports rule for the folder if straightforward, else a unit test asserting the module graph via a comment-documented convention). Bundle budgets untouched (SDK unaffected). `vp check` + `vp test` green at root; report every rrweb enum value you verified and its source line; list anything you could not derive.
