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

await buildRecorderBundle("es", "orange-replay.js", false);
await buildRecorderBundle("iife", "orange-replay.iife.js", true);

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

async function buildRecorderBundle(format, fileName, autoInit) {
  await build({
    root: packageDir,
    configFile: false,
    publicDir: false,
    logLevel: "warn",
    define: {
      __ORANGE_REPLAY_AUTO_INIT__: JSON.stringify(autoInit),
    },
    build: {
      ...commonBuild,
      lib: {
        entry: resolve(packageDir, "src/index.ts"),
        name: "OrangeReplay",
        formats: [format],
        fileName() {
          return fileName;
        },
      },
      rollupOptions: {
        output: {
          exports: "named",
        },
      },
    },
  });
}
