import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // Workspace packages import these stable subpaths while builds run in
    // parallel. Keep every public subpath in the packed export map so another
    // package never sees it disappear halfway through `vp run -r build`.
    entry: [
      "src/index.ts",
      "src/constants.ts",
      "src/insights.ts",
      "src/rage.ts",
      "src/types.ts",
      "src/wire.ts",
      "src/uuid.ts",
      "src/logger.ts",
      "src/schemas.ts",
      "src/sampling.ts",
    ],
    dts: {
      tsgo: true,
    },
    exports: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
