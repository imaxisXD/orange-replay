import path from "node:path";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig(({ command }) => {
  const uploadsSentrySourceMaps = command === "build" && hasSentrySourceMapCredentials();
  return {
    plugins: [
      react(),
      ...(uploadsSentrySourceMaps
        ? sentryVitePlugin({
            org: process.env["SENTRY_ORG"],
            project: process.env["SENTRY_PROJECT"],
            authToken: process.env["SENTRY_AUTH_TOKEN"],
            telemetry: false,
            sourcemaps: {
              filesToDeleteAfterUpload: path.resolve(
                import.meta.dirname,
                "../dashboard/dist/public/**/*.map",
              ),
            },
          })
        : []),
    ],
    define:
      command === "build"
        ? {
            "process.env.NODE_ENV": JSON.stringify("production"),
          }
        : {},
    build: {
      sourcemap: uploadsSentrySourceMaps ? "hidden" : false,
      outDir: path.resolve(import.meta.dirname, "../dashboard/dist/public"),
      emptyOutDir: false,
      minify: "terser",
      lib: {
        entry: path.resolve(import.meta.dirname, "src/client.tsx"),
        formats: ["es"],
        fileName: "public-page",
        cssFileName: "public-page",
      },
      rollupOptions: {
        output: {
          entryFileNames: "public-page.js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "[name][extname]",
        },
      },
    },
    lint: {
      options: {
        typeAware: true,
        typeCheck: true,
      },
    },
    fmt: {},
    test: {
      environment: "happy-dom",
    },
  };
});

function hasSentrySourceMapCredentials(): boolean {
  return ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"].every((name) =>
    process.env[name]?.trim(),
  );
}
