import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * Act 0 of activation rings the shell's workspace switcher in amber while the
 * visitor types their website name. The ring lives in `onboarding.css` and the
 * control it styles lives in `AppShell`, so the two are joined only by a
 * selector — nothing type-checks that join.
 *
 * It broke exactly that way once: the trigger's `aria-label` was renamed
 * "Project" → "Workspace" when a workspace grew to hold many websites, and the
 * CSS kept selecting `[aria-label="Project"]`. Every test passed and the
 * highlight was simply gone. The hook is now `data-shell-switcher`, an attribute
 * that exists for this and nothing else, and this test is the join.
 *
 * The companion `onboarding-camera-hook.test.tsx` checks the other half: that
 * the attribute survives `SelectTrigger` and reaches the DOM.
 */
// Resolved with `fileURLToPath` + `join` rather than `new URL(relative, base)`:
// happy-dom replaces the global `URL`, and its copy cannot resolve `file:`
// URLs, so the URL form throws ERR_INVALID_URL_SCHEME inside `readFileSync`.
const testDir = dirname(fileURLToPath(import.meta.url));
const shellSource = readFileSync(join(testDir, "../src/routes/app-shell.tsx"), "utf8");
const onboardingShellSource = readFileSync(
  join(testDir, "../src/routes/onboarding/onboarding-shell.tsx"),
  "utf8",
);
const onboardingCss = readFileSync(
  join(testDir, "../src/routes/onboarding/onboarding.css"),
  "utf8",
);
const previewSource = readFileSync(
  join(testDir, "../src/routes/onboarding/onboarding-preview.tsx"),
  "utf8",
);

describe("the activation camera's highlight stays attached to the shell", () => {
  it("marks the workspace switcher with the hook the camera styles", () => {
    expect(shellSource).toContain("data-shell-switcher");
  });

  it("styles that hook, and keys nothing off the switcher's label", () => {
    expect(onboardingCss).toContain("[data-shell-switcher]");
    expect(onboardingCss).not.toMatch(/\[aria-label="(Project|Workspace)"\]/);
  });

  it("keeps the ring, its bloom and its opaque surface on the zoomed switcher", () => {
    const rule = onboardingCss
      .split('.onboarding-canvas[data-camera="project"] [data-shell-switcher] {')[1]
      ?.split("}")[0];
    expect(rule, "the camera-zoom rule is no longer a single block").toBeDefined();
    // The three layers the highlight is made of: an opaque chip, a 1px amber
    // rim, and at least one amber bloom. Losing any one of them leaves a
    // different effect behind. Intensities are deliberately not pinned — they
    // get tuned by eye, and a test that fails on tuning teaches nothing.
    expect(rule).toMatch(/background: var\(--surface-\d\)/);
    expect(rule).toMatch(/inset 0 0 0 1px (var\(--amber\)|color-mix\(in oklab, var\(--amber\))/);
    expect(rule).toMatch(/0 0 \d+px color-mix\(in oklab, var\(--amber\)/);
  });

  it("still drives the rule from the preview's camera attribute", () => {
    expect(previewSource).toContain('data-camera={isNamingProject ? "project" : "overview"}');
  });
});

describe("the onboarding steps stay aligned with the dashboard preview", () => {
  it("anchors the shared desktop step frame to the dashboard header line", () => {
    // This wrapper owns every route's progress rail and Outlet, so one anchor
    // keeps Website, Install and Verify on the same line. The preview begins at
    // 17.6svh and its real AppShell header content lands at about 20svh.
    expect(onboardingShellSource).toContain("top-[20svh]");
    expect(onboardingShellSource).toContain("max-lg:top-[19svh]");
    expect(onboardingShellSource).not.toContain("top-[27.2svh]");
    expect(previewSource).toContain("top-[17.6svh]");
  });
});
