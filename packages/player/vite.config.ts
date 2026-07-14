import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: true,
    // This is a private workspace package. Keep package.json pointed at source
    // so a package build cannot make dashboard dev/build use stale dist files
    // or miss the extracted player stylesheet.
    exports: false,
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
