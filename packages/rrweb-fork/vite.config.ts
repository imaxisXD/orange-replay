import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: false,
    exports: true,
  },
  lint: {
    ignorePatterns: ["src/vendor/**"],
    options: {
      typeAware: false,
      typeCheck: false,
    },
  },
  fmt: {},
  test: {
    environment: "jsdom",
  },
});
