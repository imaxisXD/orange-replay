import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * The activation preview claims to be the dashboard the visitor is about to
 * get, so every label it shows has to be a label the Overview page actually
 * ships. Four of them were invented on the first pass and read plausibly, which
 * is exactly why a human reviewer would not catch the drift: the preview said
 * "Share of the session spent interacting" where the product says "Estimated
 * time spent clicking, typing, or scrolling".
 *
 * This asserts against the Overview page's source text rather than rendering
 * it, because rendering Overview means a stats query, a router and a workspace
 * provider, and the thing under test is the copy, not the component.
 */
const previewSource = readFileSync(
  new URL("../src/routes/onboarding/onboarding-preview.tsx", import.meta.url),
  "utf8",
);
const overviewSource = [
  "../src/routes/overview/overview-content.tsx",
  "../src/routes/overview/overview-breakdowns.tsx",
].reduce((text, path) => text + readFileSync(new URL(path, import.meta.url), "utf8"), "");

/** Every string literal inside the preview's copy tables. */
function previewCopyStrings(constName: string): string[] {
  const table = previewSource.split(`const ${constName} = [`)[1]?.split("] as const;")[0];
  if (table === undefined) {
    throw new Error(`${constName} is no longer a literal table in onboarding-preview.tsx.`);
  }
  return [...table.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("activation preview copy tracks the Overview page", () => {
  for (const constName of ["KEY_METRICS", "BEHAVIOR_METRICS", "BREAKDOWNS"]) {
    it(`only shows ${constName} strings the Overview page ships`, () => {
      const strings = previewCopyStrings(constName);
      expect(strings.length).toBeGreaterThan(0);
      for (const value of strings) {
        expect(overviewSource, `${constName}: "${value}"`).toContain(`"${value}"`);
      }
    });
  }

  it("shows the Overview page's own no-data wording for session behavior", () => {
    expect(overviewSource).toContain('"Waiting for behavior data"');
    expect(previewSource).toContain('"Waiting for behavior data"');
  });

  it("shows every breakdown card the Overview page renders", () => {
    // Overview lays out Locations, Devices, Entry pages and Browser errors in
    // one two-column grid. A preview with fewer cards understates the product.
    for (const title of ["Locations", "Devices", "Entry pages", "Browser errors"]) {
      expect(previewCopyStrings("BREAKDOWNS")).toContain(title);
    }
  });

  it("actually renders each copy table rather than just declaring it", () => {
    // Source matching alone would stay green if `PendingOverview` returned null
    // while the constants sat unused, so assert each table is mapped into JSX.
    for (const constName of ["KEY_METRICS", "BEHAVIOR_METRICS", "BREAKDOWNS"]) {
      expect(previewSource, constName).toMatch(new RegExp(`${constName}\\.map\\(`));
    }
    expect(previewSource).toContain("<PendingOverview />");
  });
});
