import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // Workspace packages import these stable source subpaths while builds run
    // in parallel. Do not let `vp pack` rewrite package.json to point at dist,
    // because another package may resolve it before dist exists.
    entry: [
      "src/index.ts",
      "src/analytics-privacy.ts",
      "src/constants.ts",
      "src/insights.ts",
      "src/rage.ts",
      "src/types.ts",
      "src/wire.ts",
      "src/uuid.ts",
      "src/logger.ts",
      "src/privacy-selector.ts",
      "src/project-config-update.ts",
      "src/schemas.ts",
      "src/sampling.ts",
      "src/session-id.ts",
    ],
    dts: {
      tsgo: true,
    },
    exports: false,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
