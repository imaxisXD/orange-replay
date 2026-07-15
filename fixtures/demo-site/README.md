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

Profile the existing dashboard dev server without starting another server:

```bash
vp run @orange-replay/demo-site#profile:dashboard
```

The default target is the public `/demo/overview` route. To profile a private local project, pass
its URL. When local test routes are enabled, the script creates a temporary test session for that
project; otherwise pass a signed-in Playwright storage-state file.

```bash
DASHBOARD_PERF_URL=http://localhost:8787/projects/project_id/overview \
  vp run @orange-replay/demo-site#profile:dashboard

DASHBOARD_PERF_STORAGE_STATE=/absolute/path/to/storage-state.json \
  DASHBOARD_PERF_URL=http://localhost:8787/projects/project_id/overview \
  vp run @orange-replay/demo-site#profile:dashboard -- --assert
```

The report covers load paint, Overview tab and date-range responsiveness, request counts, the first
and warm Overview → Sessions route change, API aborts, long tasks, memory, and scroll frame timing.
Set `DASHBOARD_PERF_OUTPUT` to save the JSON report. `--assert` makes budget warnings fail the
command; without it the script is report-only.

The e2e starts the local Worker with dev test routes, starts the Vite demo site,
records real browser actions, waits for finalize, then reads the stored session
through the Worker API.
