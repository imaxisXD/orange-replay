# @orange-replay/sdk

Browser recorder SDK for Orange Replay.

## Build

```sh
vp run @orange-replay/sdk#build
```

The browser build writes minified files to `dist/`:

- `orange-replay.js` ESM bundle
- `orange-replay.iife.js` IIFE bundle with the `OrangeReplay` global
- `loader-runtime.js` minified loader runtime used only for the loader budget

## Budgets

```sh
vp run @orange-replay/sdk#budget
```

The budget task rebuilds the SDK, gzips the built outputs with Node `zlib`, and fails when:

- `dist/orange-replay.js` is over 20KB gzip
- `dist/loader-runtime.js` is over 2KB gzip
