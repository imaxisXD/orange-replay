# rrweb upstream

- Upstream repo: https://github.com/rrweb-io/rrweb
- Vendored tag: `rrweb@2.1.0`
- Vendored commit: `c382034c73438dd0e1b19ac723c110bf46324bdb`
- Vendored date: 2026-07-04
- Reason for tag: this is the latest stable non-prerelease rrweb 2.x tag returned by the GitHub releases/tags API during vendoring. No alpha fallback was needed.

## Included

- `packages/rrweb/src/record/**`, limited to the DOM recording path.
- `packages/rrweb/src/types.ts` and `packages/rrweb/src/utils.ts`, because the record path imports them.
- `packages/rrweb-snapshot/src/snapshot.ts`, `snapshot-utils.ts`, `types.ts`, and `utils.ts`, because the record path uses snapshot serialization and masking helpers.
- `packages/types/src/index.ts`, vendored as `src/vendor/rrweb-types/index.ts`.
- `packages/utils/src/index.ts`, vendored as `src/vendor/rrweb-utils/index.ts`.
- The upstream MIT `LICENSE`.

## Excluded

- rrweb replay/player code and styles.
- rrweb packer code and pako paths.
- rrweb plugins for console, network, canvas WebRTC, and sequential id.
- rrweb-snapshot rebuild/replay utilities and PostCSS replay helpers.
- Tests, fixtures, benchmarks, docs, build scripts, and package manager files from upstream.
- Upstream canvas API-call capture, its inline worker, and `base64-arraybuffer`. Orange Replay uses a smaller local image-frame recorder instead.

## Local changes

- Added local package/build glue: `package.json`, `vite.config.ts`, `tsconfig.json`, and `src/index.ts`.
- Rewrote upstream package import specifiers for `@rrweb/types`, `@rrweb/utils`, `rrweb-snapshot`, and `rrdom` to local vendored paths so root workspace tests can load the fork without extra aliases.
- Added a capture-only `src/vendor/rrweb-snapshot/index.ts` so snapshot recording does not pull rebuild/replay helpers into the fork.
- Added `src/vendor/rrdom-stub.ts` and `src/vendor/rrweb/replay.ts` type stubs for replay-only type references left in upstream shared files.
- Replaced upstream `record/observers/canvas/canvas-manager.ts` with a bounded 1–4 FPS image-frame recorder. It deduplicates frames, caps dimensions and bytes, skips blocked or unreadable canvases, and emits only the fixed frame format allowed by Orange Replay's sanitizer.
- Tightened image inlining so large images are skipped and cross-origin failures never change or reload the customer's live `<img>` element.
- Added a small `jsdom` test dependency to this package only because rrweb's recorder expects browser DOM APIs such as `DOMTokenList.prototype`.
- This package exports TypeScript source directly from `./src/index.ts`, matching the in-repo SDK import path. The package build script is intentionally a no-op and `pack.dts` is disabled because `vp pack`/`tsgo` hung on the vendored rrweb tree in an earlier run. Declaration output is not required for this private workspace package.
- This package relaxes TypeScript strictness only for the fork: `strict`, `noUnusedLocals`, and `noUncheckedIndexedAccess` are disabled in `packages/rrweb-fork/tsconfig.json`. `skipLibCheck` stays enabled. The reason is upstream vendored code is not authored to this repo's stricter package flags.
- This package uses TypeScript `moduleResolution: "bundler"` because upstream rrweb source uses browser-bundler style extensionless imports.
- Vite Plus lint ignores `src/vendor/**` for this package, and the root workspace lint config also ignores `packages/rrweb-fork/src/vendor/**` because root `vp check` is the workspace lint entry point. The vendored files were formatted by Oxfmt and are compiled through the package entry/build path.

## Resync procedure

1. Fetch the upstream tag outside this repo, for example into `/tmp`.
2. Confirm the tag commit SHA through GitHub tags/releases.
3. Copy the same included source paths into `packages/rrweb-fork/src/vendor`.
4. Compare the vendored `src/vendor` tree against the fetched tag.
5. Reapply the local build glue and stubs listed above.
6. Run `export PATH="$HOME/.vite-plus/bin:$PATH" && vp install && timeout 300 vp check && timeout 300 vp test` from the repo root.
