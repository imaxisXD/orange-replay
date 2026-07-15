import path from "node:path";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";

const workerUrl = process.env["VITE_WORKER_URL"] ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: lazyPlugins(() => [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()]),
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-runtime",
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 20,
              includeDependenciesRecursively: false,
            },
            {
              name: "replay-engine",
              test: (moduleId) =>
                /[\\/]packages[\\/]player[\\/]/.test(moduleId) ||
                /node_modules[\\/](?:@rrweb[\\/]|@xstate[\\/]fsm[\\/]|base64-arraybuffer[\\/]|css-tree[\\/]|mitt[\\/]|rrdom[\\/]|rrweb[\\/]|rrweb-snapshot[\\/]|source-map-js[\\/])/.test(
                  moduleId,
                ),
              priority: 10,
              maxSize: 350 * 1024,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: workerUrl,
        changeOrigin: true,
        // Live session watching upgrades to a WebSocket on the same path.
        ws: true,
      },
      "/v1": {
        target: workerUrl,
        changeOrigin: true,
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
});
