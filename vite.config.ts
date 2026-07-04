import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    // Hand-tuned design reference mocks (design authority for the dashboard UI) — never reformat.
    ignorePatterns: ["design-final.html", "design-directions*.html"],
  },
  lint: {
    ignorePatterns: ["packages/rrweb-fork/src/vendor/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.wrangler/**", "**/.claude/**"],
  },
});
