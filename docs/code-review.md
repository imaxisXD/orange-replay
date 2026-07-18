# Code review protocol

This protocol is required for every code review. A green type check, test suite, build, security scan, or React scan is useful evidence, but it is not a complete review by itself.

“Test everything” means test every affected behavior and every affected layer. It does not mean trying every possible input. The reviewer must first identify the full path changed by the work, then prove each affected part of that path.

## 1. Trace the change end to end

Before giving a verdict, write a short impact map and follow changed data and behavior through every affected layer:

1. Browser input, SDK event, scheduled job, or operator action.
2. Durable Object, D1, R2, KV, Queue, Pipeline, or other stored state.
3. Backend rules, calculations, filtering, caching, and authorization.
4. API request and response fields, shared types, schemas, and decoders.
5. Frontend data mapping, state, formatting, and routing.
6. Every user-visible surface that consumes the result: text, charts, tooltips, tables, filters, empty states, errors, loading states, and accessibility labels.
7. Every affected interaction: hover, focus, click, keyboard, touch, refresh, navigation, and retry.
8. Deployment, self-host template, migration, recovery, and operational behavior when the change reaches those surfaces.

A backend change is not fully reviewed until the reviewer finds its frontend consumers and verifies what users will see and do differently. A frontend change must also be traced backward to the API and stored value so the reviewer knows whether the UI is showing the correct field.

If a layer is not affected, say why. Do not silently skip it.

## 2. Keep internal identity separate from display text

Values used for keys, deduplication, routing, filters, cache identity, or database joins must not automatically become user-visible text.

When data contains both an internal value and a display value, the reviewer must:

- identify which field owns identity and which field owns presentation;
- search every consumer of both fields;
- verify visible text uses the display value;
- verify URLs, query strings, IDs, tokens, and storage keys do not leak into labels, tooltips, accessibility text, or error messages;
- keep the internal value where correctness requires it instead of weakening identity to make the UI look right.

## 3. Review every affected surface and state

List the concrete surfaces before testing. Include all call sites of a changed shared component or shared contract, not only the page where the change started.

For each affected surface, check the states that can change, including:

- normal, empty, loading, stale, error, unavailable, and retry states;
- live, idle, finalizing, finalized, deleted, and legacy data when relevant;
- private, demo, self-hosted, and hosted paths when they share the changed code;
- desktop and narrow layouts for visible UI;
- mouse, keyboard, focus, and touch behavior for interactive UI;
- singular, plural, zero, unknown, long, duplicate, and malformed values when relevant.

## 4. Require proof at the right boundaries

Add or run proof for every affected boundary:

- unit tests for calculations and decision rules;
- contract tests for stored data and API fields;
- component tests for exact user-visible text and state;
- browser tests for hover, focus, click, keyboard, routing, and rendered layout;
- screenshot comparison for visible UI changes;
- an end-to-end test when data crosses backend and frontend boundaries;
- a regression test that fails for the reported bug before the fix and passes after it.

Test exact outcomes, not only that a component rendered or a request returned `200`. When a visible value matters, assert the visible value. When geometry matters, assert bounds. When an interaction matters, perform the interaction.

If required proof cannot be run, record the missing check and the reason. Do not call the review passed while an affected user path remains unverified.

## 5. Required review report

Every reviewer report must include:

1. **Impact map** — changed source, stored state, backend logic, API contract, frontend consumers, and user-visible result.
2. **Surface and state list** — every affected page, shared component, interaction, and important state.
3. **Evidence** — exact tests, browser actions, screenshots, commands, and results.
4. **Findings** — ordered by user impact, with file and line evidence.
5. **Untested areas** — anything not exercised and why.
6. **Verdict** — pass only when every affected path has proof or a clearly accepted exception.

## Regression example: breakdown chart tooltips

The Overview breakdown chart used `categoryKey` as a unique band-scale key. That key was a serialized Sessions filter such as `from=...&to=...&country=SG`. The same chart data also contained the correct display name, such as `Singapore`.

The review correctly checked that `categoryKey` kept same-named cities separate, but it did not trace that key into the shared tooltip, which used the scale key as its visible title. Generic tests passed because none hovered the Overview charts and asserted their headings.

The required regression proof is:

- keep the unique internal key for chart identity;
- hover every breakdown type and its full-list version;
- assert the tooltip heading equals the displayed label;
- assert tooltip headings never contain `from=`, `to=`, filter query parameters, IDs, or other internal keys;
- cover Country, City, Device type, Browser, OS, and Entry page consumers of the shared chart.
