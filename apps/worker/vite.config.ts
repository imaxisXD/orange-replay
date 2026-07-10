import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  test: {
    env: {
      // Worker tests provide their own vars. Never load a developer's local secrets.
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    },
  },
});
