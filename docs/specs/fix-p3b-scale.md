# FIX-P3b — replay scale-to-fit + geometric e2e hardening

User-visible bug: the replay viewport renders recorded pages at their ORIGINAL pixel size, so any session recorded on a window larger than the player stage shows as a top-left crop (only a strip of the page visible). Root cause: the embed never applies rrweb's scale-to-fit transform. Scope: `packages/player/**`, `apps/dashboard/src/routes/session-detail.tsx`, `fixtures/demo-site/tests/product.e2e.ts` + tests. Do NOT run git.

## 1. Scale-to-fit in the player (packages/player)

- Track the recorded viewport dimensions: initial values come from the rrweb Meta event (`event.type === EventType.Meta` → `data.width/height`); updates come from viewport-resize incremental events and subsequent Meta events (page navigations can change size). The replayer also emits a `resize` event — prefer `replayer.on("resize", ...)` where available.
- On every dimension change AND on stage size change (observe the container with a `ResizeObserver`), apply `transform: scale(min(stageW/recordedW, stageH/recordedH))` with `transform-origin: top left` to the `.replayer-wrapper`, then center it in the stage (translate or flex-centering on the parent — content must be fully visible and centered both axes, never cropped, never upscaled beyond 1 unless the stage is larger — cap scale at 1 is NOT desired: small stages should downscale, larger stages MAY upscale to fit but cap at 1.0 to avoid blur; letterbox the remainder with the stage background).
- Overlays (cursor trail, ripples, rage bursts) draw in recorded-page coordinates — they must apply the SAME transform so effects land on the right elements after scaling. Verify the overlay canvas is positioned/scaled with the wrapper.
- Clean up the ResizeObserver in `destroy()`. No polling.
- Unit tests: scale math (mismatched dims → expected scale/centering; equal dims → 1; tiny stage → proportional), overlay coordinate mapping under scale.

## 2. Dashboard stage (apps/dashboard/src/routes/session-detail.tsx)

- The viewport stage keeps `aspect-video` but must clip cleanly (`overflow-hidden`) and center the scaled wrapper. Remove any styles that fight the transform (fixed offsets on the wrapper).
- The live "waiting for keyframe" and buffering overlays remain full-stage.

## 3. Geometric e2e hardening (fixtures/demo-site/tests/product.e2e.ts)

- In the "record -> list" step, set the RECORDING context's viewport explicitly larger than the dashboard watcher's player stage (e.g. `browser.newContext({ viewport: { width: 1600, height: 1000 } })`), and give the dashboard context a smaller viewport (e.g. 1100×700) so recorded-vs-stage mismatch is guaranteed.
- In the "playback with effects" step add assertions:
  1. the replay iframe's rendered bounding box fits INSIDE the player stage element's box (both axes, with tolerance ±2px);
  2. the wrapper has a non-identity scale when recorded width > stage width (read the computed transform, assert scale < 1);
  3. content is horizontally centered within the stage (|left gap − right gap| ≤ 4px).
- Keep all existing assertions.

## Definition of done

`export PATH="$HOME/.vite-plus/bin:$PATH" && vp check` green at root; `vp test` green for packages/player + apps/dashboard. Do not run Playwright/workerd (I run the gate). Report files changed and anything incomplete.
