# Install The SDK

Paste the loader snippet before `</head>`. The dashboard Install page is the source of truth; it calls `buildLoaderScriptTag` from `@orange-replay/sdk/loader` with your project values.

The Install page does not copy placeholder credentials. Paste the raw write key that was shown when you created it, confirm the Worker URL or custom domain, then copy the generated snippet. Production write keys use the `or_live_` prefix followed by 32 base64url characters.

The SDK write key is a public browser credential, not a server secret. It identifies the project for ingest and is still checked on every batch, but any browser page that loads the SDK can see it. Use exact allowed origins for browser CORS, and rely on server-side lookup limits, project limits, session limits, quotas, payload caps, and session caps for abuse control. Sampling is an honest-client optimization, not an abuse control. Do not put dashboard account credentials or Cloudflare tokens in browser code.

The dashboard builds the same snippet with:

```ts
import { buildLoaderScriptTag } from "@orange-replay/sdk/loader";

const origin = new URL(workerUrl).origin;
const snippet = buildLoaderScriptTag({
  bundleUrl: `${origin}/or-recorder.js`,
  init: { key: rawWriteKey, ingestUrl: origin },
});
```

## Init Options

| Option          | Required           | Default     | What it does                                                                                |
| --------------- | ------------------ | ----------- | ------------------------------------------------------------------------------------------- |
| `key`           | Yes                | None        | Project write key used by ingest auth.                                                      |
| `ingestUrl`     | Yes                | None        | Worker origin that receives `/v1/ingest`.                                                   |
| `sampleRate`    | No                 | `1`         | Fraction from `0` to `1`. Use `0` as a client-side kill switch.                             |
| `flushMs`       | No                 | SDK default | Max time between normal flushes. The Worker can tighten cadence when live watch is active.  |
| `blockSelector` | No                 | None        | Extra CSS selector to block, merged with `[data-orange-block]`.                             |
| Kill switch     | No separate option | None        | Use `sampleRate: 0` for a client rollout stop, or disable the write key/server quota state. |

The SDK also supports `transport: "inline"` for sites that cannot allow Blob workers.

## Masking Defaults

- Any element inside `[data-orange-block]` is blocked.
- All input values are masked by default.
- Use `blockSelector` for extra blocked areas, for example `.payment-form`.

## Sessions

- A browser session rotates after 30 minutes of idle time.
- Multi-page navigation keeps the same session when browser storage is available.
- Each tab gets its own tab id, so events from two tabs do not collide.

## CSP

The default SDK transport creates a Blob Web Worker for compression and batching. Add this to your CSP:

```txt
worker-src blob:
```

If that is not allowed, set `transport: "inline"`. Capture still works, but more work happens on the main thread. The SDK does not switch to inline mode automatically because a surprise main-thread snapshot can slow the customer page.

## Bundle Budgets

- Core recorder bundle: <=35KB gzip hard limit.
- Loader snippet: <2KB.
