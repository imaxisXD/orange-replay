import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = resolve(packageDir, "dist");

await rm(distDir, { recursive: true, force: true });

const commonBuild = {
  target: "es2022",
  minify: true,
  sourcemap: false,
  emptyOutDir: false,
  outDir: distDir,
};

await build({
  root: packageDir,
  configFile: false,
  publicDir: false,
  logLevel: "warn",
  build: {
    ...commonBuild,
    lib: {
      entry: resolve(packageDir, "src/index.ts"),
      name: "OrangeReplay",
      formats: ["es", "iife"],
      fileName(format) {
        return format === "es" ? "orange-replay.js" : "orange-replay.iife.js";
      },
    },
    rollupOptions: {
      output: {
        exports: "named",
      },
    },
  },
});

await build({
  root: packageDir,
  configFile: false,
  publicDir: false,
  logLevel: "warn",
  build: {
    ...commonBuild,
    lib: {
      entry: resolve(packageDir, "src/loader-runtime.ts"),
      name: "OrangeReplayLoader",
      formats: ["iife"],
      fileName() {
        return "loader-runtime.js";
      },
    },
  },
});
