# Orange Replay Demo Site

Small Vite site used for the real-browser recording e2e.

## Setup

```sh
vp install
npx playwright install chromium
```

## Run

```sh
vp run @orange-replay/demo-site#e2e
```

The e2e starts the local Worker with dev test routes, starts the Vite demo site,
records real browser actions, waits for finalize, then reads the stored session
through the Worker API.
