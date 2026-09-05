# Replay decoder startup repair

## Problem and impact map

The deployed dashboard returned the recording segment successfully but its decode worker stopped with `ReferenceError: countReplayValues is not defined`. The September 5 shared replay-limit change added that helper. The production dashboard splits the player and the shared helper into chunks that import each other. Eager worker-source strings could capture `undefined` before the helper's chunk finished initializing. Development imports and source-level worker tests did not exercise this load order.

The player now builds its validator and decode-worker source when a player creates a worker, after application modules have initialized. The optional main-thread decoder also creates and caches its validator on first use instead of capturing the helper during module initialization. Retry and worker replacement use the same complete source.

The shared decoder serves private session detail, the Sessions panel, demo replay, public replay, and live replay. A saved segment or live batch follows the existing download, decode, validation, sanitization, and rendering path. Validation rules, resource limits, iframe protections, and worker-failure limits are unchanged. This changes neither recording capture nor storage, backend logic, API fields, authorization, database migrations, queue behavior, or displayed copy.

## Evidence

- The reported recording was downloaded through read-only R2 requests. All eight saved segment sizes match the manifest. The generated decoder read all 34 batches: 415 replay events and eight full snapshots, with no decode or accepted-time-range errors. No production objects were changed.
- `vp install`: already up to date; no dependencies added.
- The permanent initialization regression imports the player while the shared exports are unavailable, then makes those exports available before playback. Both tests fail with the original code: the generated worker throws the reported `ReferenceError`, and the fallback decoder throws `TypeError: countValues is not a function`. Both pass after the fix. The temporary baseline restoration was limited to the three owned source files and restored in a `finally` block.
- Focused initialization, generated-worker, and recorder/player contract tests: 73 tests across three files pass.
- `vp check`: no formatting, lint, type errors, or warnings.
- `vp test`: initially 1,768 tests across 228 files passed. Before pushing, the fix was rebased onto the dependency update `4a03905`; `vp install`, clean `vp check`, all 1,769 tests across 229 files, both app builds, and all five production playback browser cases pass on the combined result.
- Dashboard and public-page production builds pass.
- Six fresh capture/replay browser cases pass using both shipped SDK formats, covering DOM changes, input/text masking, images, frames, shadow DOM, and canvas on/off. The first attempt was blocked by HTTP 403 because the existing dev server serves a different worktree. For verification, the existing test helper was bundled from this checkout and fulfilled through a temporary Playwright route; the test file was restored byte-for-byte afterward. No extra dev server or permanent SDK test change was needed.
- Independent source, initialization-test, and production-browser-harness reviews found no blocking issue.
- The preserved original dashboard build reproduces the same `countReplayValues is not defined` worker error in the permanent browser harness. The rebuilt dashboard passes private detail, embedded Sessions selection, and legacy/demo playback with play/pause and timeline start/end interactions. The built public page passes shared playback, using the real server renderer compiled for the test.
- All five production browser cases pass when `PLAYBACK_RECORDING_DIR` points to the downloaded recording. The saved session opens, switches Tab 2 and back to Tab 1, and accepts beginning/middle/end seeks without decoder errors. Screenshots at the beginning and middle were visually inspected and show the NDLE landing page and links dashboard. The exact end screenshot is blank; this check proves the startup repair and successful middle playback, not frame-by-frame fidelity of every moment.
- The new `e2e:production` command builds both browser surfaces before testing, requires no dev server, and uses synthetic current and legacy recordings by default. The real recording is optional local input and is not checked into the repository.

Verdict: the reported startup failure is fixed and locally verified. Production has not been deployed by this task.

## Release boundary

The repair must reach the dashboard and public-page browser assets. It requires no recording rewrite, recorder reinstall, or schema migration. No deployment has been performed in this task.
