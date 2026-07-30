import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * The activation preview shows the real `AppShell` with placeholders where the
 * page body would be. It must not render product copy of its own.
 *
 * This started as a drift test: the preview used to show the Overview page's
 * real metric labels, four of which had been invented and read plausibly enough
 * to survive review ("Share of the session spent interacting" where the product
 * says "Estimated time spent clicking, typing, or scrolling"). Matching the
 * source strings caught that, but the honest fix was to stop asserting anything
 * at all — a preview with no copy cannot promise what the product does not ship.
 * So the invariant flipped: assert the body is copy-free.
 */
const previewSource = readFileSync(
  new URL("../src/routes/onboarding/onboarding-preview.tsx", import.meta.url),
  "utf8",
);
const overviewSource = [
  "../src/routes/overview/overview-content.tsx",
  "../src/routes/overview/overview-breakdowns.tsx",
].reduce((text, path) => text + readFileSync(new URL(path, import.meta.url), "utf8"), "");

/** Every metric label and card description the real Overview page renders. */
const OVERVIEW_COPY = [
  "Sessions",
  "Average session length",
  "Pages per session",
  "Live now",
  "Session behavior",
  "Rage clicks",
  "Quick returns",
  "Interaction time",
  "Scroll depth",
  "Locations",
  "Devices",
  "Entry pages",
  "Browser errors",
  "Completed in this time range",
  "Waiting for session data",
  "Waiting for behavior data",
  "Where people used your product",
];

describe("the activation preview renders no product copy", () => {
  it("names strings the Overview page really does ship, so the check is not vacuous", () => {
    // If Overview is refactored and these stop existing, the assertions below
    // would pass for the wrong reason.
    const shipped = OVERVIEW_COPY.filter((value) => overviewSource.includes(`"${value}"`));
    expect(shipped.length).toBeGreaterThanOrEqual(OVERVIEW_COPY.length - 2);
  });

  it("does not reproduce any of it in the preview", () => {
    for (const value of OVERVIEW_COPY) {
      expect(previewSource, `preview should not render "${value}"`).not.toContain(`"${value}"`);
    }
  });

  it("renders no JSX text nodes in the pending page body", () => {
    // Placeholders only: the body is <Bar /> elements and layout wrappers, so no
    // heading or paragraph tags should survive in it.
    const body = previewSource.slice(previewSource.indexOf("function PendingOverview"));
    expect(body).not.toMatch(/<h[12]\b/);
    expect(body).not.toMatch(/<p\b/);
    expect(body).not.toMatch(/<span[^/>]*>[A-Za-z]/);
  });

  it("keeps the placeholder geometry varied so the band is not uniform bars", () => {
    // Equal widths would read as four identical grey rectangles rather than as
    // the dashboard's own rhythm.
    for (const constName of ["KEY_METRICS", "BEHAVIOR_METRICS", "BREAKDOWNS"]) {
      const table = previewSource.split(`const ${constName} = [`)[1]?.split("] as const;")[0];
      expect(table, `${constName} is no longer a literal table`).toBeDefined();
      const widths = [...(table ?? "").matchAll(/:\s*(\d+)/g)].map((match) => Number(match[1]));
      expect(widths.length).toBeGreaterThan(4);
      expect(new Set(widths).size).toBeGreaterThan(widths.length / 2);
    }
  });
});
