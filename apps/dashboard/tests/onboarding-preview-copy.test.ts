import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
 *
 * Act 2 now has one exception, and it is held to a narrower rule rather than
 * loosening this one: the Live page's "Live now" badge. See the test at the
 * bottom for why it earns the exception and what keeps it honest.
 */
// Resolved with `fileURLToPath` + `join` rather than `new URL(relative, base)`:
// happy-dom replaces the global `URL`, and its copy cannot resolve `file:`
// URLs, so the URL form throws ERR_INVALID_URL_SCHEME inside `readFileSync`.
const testDir = dirname(fileURLToPath(import.meta.url));
const previewSource = readFileSync(
  join(testDir, "../src/routes/onboarding/onboarding-preview.tsx"),
  "utf8",
);
/** Comments stripped: this file explains its own copy rules in prose. */
const previewCode = previewSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const installStatusSource = readFileSync(
  join(testDir, "../src/routes/install/install-status.tsx"),
  "utf8",
);
const overviewSource = [
  "../src/routes/overview/overview-content.tsx",
  "../src/routes/overview/overview-breakdowns.tsx",
].reduce((text, path) => text + readFileSync(join(testDir, path), "utf8"), "");

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
      expect(previewCode, `preview should not render "${value}"`).not.toContain(`"${value}"`);
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

  it("borrows the one string it does show from the product's own component", () => {
    // Act 2's exception. Every metric on Overview needs a finalised session to
    // be true, which is why the preview shows none of them; "Live now" needs
    // only a session to exist, and one just did — it is the single fact the
    // product can state seconds after an install.
    //
    // The exception is kept honest by where the words come from: the preview
    // renders `LiveBadge`, so the string is the product's and cannot drift. The
    // moment it is retyped here it is an invention again, which is exactly how
    // the four fake metric labels got in.
    expect(previewCode).toContain("<LiveBadge />");
    expect(previewCode, "the badge's words must come from the component").not.toContain(
      '"Live now"',
    );

    // And the row under it still invents nothing: onboarding knows an event
    // arrived, not who sent it, so there is no country, path or duration here.
    const live = previewSource.slice(previewSource.indexOf("function PendingLive"));
    const liveBody = live.slice(0, live.indexOf("\n}"));
    expect(liveBody).not.toMatch(/CountryFlag|formatRelativeTime|formatLiveSessionRow/);
  });

  it("borrows the Install page's waiting words rather than writing its own", () => {
    // The second exception, and the same shape as the first: step two's preview
    // shows the Install page in the state that step is actually in, and the real
    // page already ships that state — spinner, sentence and all. Rewriting it
    // here is what would make it an invention.
    //
    // It is copied rather than imported: `InstallStatus` fetches, polls and
    // renders alerts, and mounting it would put a live query inside a picture.
    // This test is the join. If it fails, the product changed its words and the
    // preview has to follow.
    const waiting = previewSource.split("const INSTALL_WAITING = {")[1]?.split("} as const;")[0];
    expect(waiting, "INSTALL_WAITING is no longer a literal").toBeDefined();
    const strings = [...(waiting ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(strings.length).toBe(2);
    for (const value of strings) {
      expect(installStatusSource, `the Install page no longer says "${value}"`).toContain(
        `${value}`,
      );
    }
  });

  it("does not draw the Install signal field while that preview page is hidden", () => {
    const install = previewSource.slice(
      previewSource.indexOf("function PendingInstall"),
      previewSource.indexOf("const INSTALL_WAITING"),
    );
    expect(previewCode).toContain("isShown={page === PREVIEW_PAGE.install}");
    expect(install).toContain("isShown && !isInstalled");
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
