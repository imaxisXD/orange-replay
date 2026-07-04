# Install The SDK

Paste the loader snippet before `</head>`. The dashboard Install page is the source of truth; it calls `buildLoaderSnippet` from `@orange-replay/sdk/loader` with your project values.

```text
<script>
(function(c){var w=window,d=document;if(w.__orLoaderStarted)return;w.__orLoaderStarted=1;var q=w.__orq=w.__orq||[],r=w.__orCleanup=w.__orCleanup||[],l=c.queueLimit>0?Math.floor(c.queueLimit):100,b="[data-orange-block]"+(c.init&&c.init.blockSelector?", "+c.init.blockSelector:""),n=function(){return Date.now()},t=function(v){v=String(v);return v.length>200?v.slice(0,200):v},p=function(o){if(typeof o.t!=="number")o.t=n();if(q.length>=l)q.splice(0,q.length-l+1);q.push(o)},a=function(x,y,f){x.addEventListener(y,f,true);r.push(function(){x.removeEventListener(y,f,true)})},h=function(v){return String(v).replace(/[^a-zA-Z0-9_-]/g,"_")},g=function(e){var z=e.tagName.toLowerCase(),i=e.id?"#"+h(e.id):"",c="",j=0;if(e.classList)for(;j<e.classList.length&&j<3;j++)c+="."+h(e.classList[j]);return z+i+c},s=function(e){if(!e||!e.tagName)return"unknown";for(var p=[],x=e;x&&p.length<3;x=x.parentElement)p.unshift(g(x));return t(p.join(" > "))},m=function(e){try{return e&&e.closest&&e.closest(b)?"[blocked]":s(e)}catch(_){try{return e&&e.closest&&e.closest("[data-orange-block]")?"[blocked]":s(e)}catch(_){return s(e)}}};if(c.init){w.__orInit=c.init;p({k:"init",o:c.init})}a(w,"error",function(e){p({k:"error",m:t(e.message||String(e.error||"error"))})});a(w,"unhandledrejection",function(e){var r=e.reason;p({k:"unhandledrejection",m:t(r&&r.message?r.message:String(r))})});a(d,"click",function(e){p({k:"click",d:m(e.target),x:e.clientX||0,y:e.clientY||0,w:w.innerWidth||0,h:w.innerHeight||0})});p({k:"vital",n:"navigation",start:w.performance&&w.performance.timeOrigin||n()});var o=d.createElement("script");o.async=1;o.src=c.bundleUrl;d.head.appendChild(o)})({bundleUrl:"https://YOUR_HOST/or-recorder.js",init:{"key":"YOUR_WRITE_KEY","ingestUrl":"https://YOUR_HOST"}});
</script>
```

Replace:

- `YOUR_HOST` with your Worker URL or custom domain.
- `YOUR_WRITE_KEY` with the project write key.

The dashboard builds the same snippet with:

```ts
import { buildLoaderSnippet } from "@orange-replay/sdk/loader";

const snippet = buildLoaderSnippet({
  bundleUrl: "https://YOUR_HOST/or-recorder.js",
  init: { key: "YOUR_WRITE_KEY", ingestUrl: "https://YOUR_HOST" },
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

If that is not allowed, set `transport: "inline"`. Capture still works, but more work happens on the main thread.

## Bundle Budgets

- Core recorder bundle: <=35KB gzip hard limit.
- Loader snippet: <2KB.
