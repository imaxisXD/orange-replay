import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";

const workerUrl = process.env["VITE_WORKER_URL"] ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: lazyPlugins(() => [react(), tailwindcss()]),
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: workerUrl,
        changeOrigin: true,
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
