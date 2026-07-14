import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
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
});
