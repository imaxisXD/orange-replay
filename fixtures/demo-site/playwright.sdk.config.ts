import { defineConfig } from "@playwright/test";

// Reuse a running repository server; this suite needs no backend or extra server.
if (!process.env.SDK_VERIFY_ORIGIN) {
  throw new Error("Set SDK_VERIFY_ORIGIN to the URL of the running repository dev server.");
}

export default defineConfig({
  testDir: "./tests",
  testMatch: ["sdk-bundle-fidelity.e2e.ts", "architecture.e2e.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  reporter: [["list"]],
  use: { browserName: "chromium", headless: true, trace: "retain-on-failure" },
});
