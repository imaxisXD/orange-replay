import { expect, test, type Page } from "@playwright/test";
import { buildSegment, encodeIngestBody } from "../../../packages/shared/src/wire.ts";
import type { PublicPageData, SessionManifest } from "../../../packages/shared/src/types.ts";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

const origin = process.env.SDK_VERIFY_ORIGIN!;
const helper = `/@fs${resolve("../../apps/dashboard/tests/architecture-proof.tsx")}`;
const preamble = `<script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;</script>`;

async function openProof(
  page: Page,
  surface: string,
  { manifest, segment, data }: ReturnType<typeof recording>,
) {
  await page.route(`${origin}/__architecture-proof`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><head>${preamble}</head><body></body></html>`,
    }),
  );
  await page.route(`${origin}/api/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/manifest")) await route.fulfill({ json: manifest });
    else if (path.endsWith(".ors"))
      await route.fulfill({
        contentType: "application/octet-stream",
        body: Buffer.from(segment),
      });
    else if (path.endsWith("/pub_test")) await route.fulfill({ json: data });
    else await route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.goto(`${origin}/__architecture-proof`);
  await page.evaluate(
    async ({ helper, surface, manifest, data }) => {
      const module = await import(helper);
      await module.mountArchitectureProof(surface, manifest, data);
    },
    { helper, surface, manifest, data },
  );
}

for (const width of [1280, 390]) {
  test.describe(`${width}px input`, () => {
    test.use({ hasTouch: width === 390 });
    for (const surface of ["private", "demo", "public", "analytics", "settings"]) {
      test(`${surface}: tab journeys and status at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await openProof(page, surface, recording());
        if (surface === "analytics") {
          await expect(page.getByText("Fixed analytics snapshot")).toBeVisible();
          await expect(page.getByText("Live count temporarily unavailable")).toBeVisible();
          await expect(page.getByLabel("Live count unavailable")).toHaveText("—");
          const latest = page.getByRole("button", { name: "Show latest results" });
          await latest.focus();
          await page.keyboard.press("Enter");
          await expect(page.getByText("Recent analytics are still arriving")).toBeVisible();
          await expect(page.getByText(/2 analytics updates waiting to appear/)).toBeVisible();
        } else if (surface === "settings") {
          await expect(
            page.getByText(/Input values are masked by default. Page text is masked only/),
          ).toBeVisible();
          await expect(
            page.getByText("No custom rules. Inputs are masked by default."),
          ).toBeVisible();
          await page.getByRole("button", { name: "Add rule" }).click();
          await page.getByLabel("Mask rule 1 selector").fill(".account-secret");
          const action = page.getByRole("combobox", { name: "Mask rule 1 action" });
          await action.focus();
          await page.keyboard.press("Enter");
          await page.getByRole("option", { name: "block", exact: true }).click();
          await expect(action).toHaveText("block");
          await expect(page.getByLabel("Mask rule 1 selector")).toHaveValue(".account-secret");
          await page.getByRole("button", { name: "Remove mask rule 1" }).click();
          await expect(page.getByLabel("Mask rule 1 selector")).toHaveCount(0);
          await expect(
            page.getByText("No custom rules. Inputs are masked by default."),
          ).toBeVisible();
        } else {
          if (surface === "public") {
            await expect(
              page.getByText("Analytics are still arriving. Recent sessions may not appear yet."),
            ).toBeVisible();
            await page.getByRole("button", { name: "Watch session" }).click();
          }
          const tab = page.getByRole("combobox", { name: "Replay tab" });
          await expect(tab).toBeVisible();
          await checkMaskingDisclosure(page, /The recorder reports input values masked/, width);
          if (surface !== "public")
            await expect(page.getByTestId("replay-controls")).not.toContainText("Masking");
          const visibleTitle = () =>
            page.evaluate(() =>
              [...document.querySelectorAll<HTMLIFrameElement>(".replayer-wrapper iframe")]
                .map((frame) => frame.contentDocument?.querySelector("h1")?.textContent)
                .filter(Boolean),
            );
          if (surface === "public") {
            await tab.selectOption("opaque-tab-b");
          } else {
            await tab.focus();
            await page.keyboard.press("Enter");
            await page.getByRole("option", { name: /Tab 2/ }).click();
          }
          await expect.poll(visibleTitle).toEqual(["Checkout page"]);
          await expect(tab).toContainText("Tab 2");
          if (surface === "public") await tab.selectOption("opaque-tab-a");
          else {
            await tab.click();
            await page.getByRole("option", { name: /Tab 1/ }).click();
          }
          await expect.poll(visibleTitle).toEqual(["Catalog page"]);
          if (surface !== "public") {
            const error = page.getByRole("button", { name: /Checkout error/ });
            if (width === 390) await error.tap();
            else await error.click();
            await expect.poll(visibleTitle).toEqual(["Checkout page"]);
            await expect(tab).toContainText("Tab 2");
            await expect(page.getByRole("slider", { name: "Replay timeline" })).toHaveAttribute(
              "aria-valuenow",
              "800",
            );
            const journey = page.getByTestId("journey-breadcrumbs");
            await expect(
              journey.getByRole("button", { name: "/checkout", exact: true }),
            ).toHaveCount(1);
            await expect(
              journey.getByRole("button", { name: "/checkout/review", exact: true }),
            ).toHaveCount(1);
          }
          await expect.poll(() => replayFitsCard(page, surface)).toEqual([]);
          if (surface !== "public") {
            await expect.poll(() => compactReplayLayout(page, width)).toEqual([]);
            const lastEvent = page.getByRole("button", { name: /Final timeline event/ });
            await lastEvent.focus();
            await page.keyboard.press("Enter");
            await expect(page.getByRole("slider", { name: "Replay timeline" })).toHaveAttribute(
              "aria-valuenow",
              "950",
            );
          }
          expect(await page.locator("body").innerText()).not.toContain("opaque-tab");
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        expect(errors).toEqual([]);
        if (surface === "public") {
          await page
            .locator(".public-player")
            .screenshot({ path: info.outputPath(`public-player-${width}.png`) });
        }
        await writeFile(
          info.outputPath("layout.json"),
          JSON.stringify(
            await page.evaluate(() =>
              [
                "[data-testid='replay-stage']",
                ".replayer-wrapper",
                ".replayer-wrapper iframe",
                "[data-slot='masking-details']",
                "[role='slider']",
              ].map((selector) => {
                const element = document.querySelector(selector);
                if (!element) return { selector };
                const bounds = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                const ancestors = [];
                for (let parent = element.parentElement; parent; parent = parent.parentElement)
                  ancestors.push({
                    tag: parent.tagName,
                    class: parent.className,
                    bounds: parent.getBoundingClientRect().toJSON(),
                    display: getComputedStyle(parent).display,
                    opacity: getComputedStyle(parent).opacity,
                    overflow: getComputedStyle(parent).overflow,
                  });
                return {
                  selector,
                  bounds: bounds.toJSON(),
                  display: style.display,
                  opacity: style.opacity,
                  transform: style.transform,
                  ancestors,
                };
              }),
            ),
            null,
            2,
          ),
        );
        await page.screenshot({ path: info.outputPath(`${surface}-${width}.png`), fullPage: true });
      });
    }
    for (const surface of ["private", "demo", "public"]) {
      test(`${surface}: missing masking report and empty timeline at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        const fixture = recording();
        delete fixture.manifest.domMasking;
        delete fixture.manifest.domMaskingSummary;
        fixture.manifest.timeline = [];
        await openProof(page, surface, fixture);
        if (surface === "public") await page.getByRole("button", { name: "Watch session" }).click();
        await checkMaskingDisclosure(
          page,
          "This recording has no saved masking report. Its masking settings cannot be confirmed.",
          width,
        );
        await expect(page.getByText(/The recorder reports input values masked/)).toHaveCount(0);
        await expect.poll(() => replayFitsCard(page, surface)).toEqual([]);
        if (surface !== "public") {
          await expect(page.getByText("No events captured in this session.")).toBeVisible();
          const emptySpace = await page
            .getByTestId("replay-controls")
            .evaluate(
              (note) =>
                note.parentElement!.getBoundingClientRect().bottom -
                note.getBoundingClientRect().bottom,
            );
          expect(Math.abs(emptySpace)).toBeLessThanOrEqual(2);
        }
      });
    }
  });
}

for (const width of [1280, 390]) {
  for (const empty of [false, true]) {
    test(`expanded masking report fits with ${empty ? "empty" : "long"} timeline at ${width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = recording();
      fixture.manifest.domMaskingSummary = {
        coverage: "partial",
        policyCount: 2,
        canvas: true,
        inputs: "all",
        text: "selected",
      };
      if (empty) fixture.manifest.timeline = [];
      await openProof(page, "private", fixture);
      await page.getByText("Masking details", { exact: true }).click();
      const report = page.locator("[data-slot='masking-details']");
      await expect(report).toContainText("Masking settings differed");
      await expect(report).toContainText("Some masking details are unavailable");
      await expect(report).toContainText("Canvas pixels were captured");
      const bounds = await report.evaluate((report) => {
        const sidebar = report.closest("aside")!;
        const content =
          sidebar.querySelector("[data-slot='scroll-area-viewport']") ?? sidebar.lastElementChild!;
        return {
          reportBottom: report.getBoundingClientRect().bottom,
          contentBottom: content.getBoundingClientRect().bottom,
          sidebarBottom: sidebar.getBoundingClientRect().bottom,
          contentHeight: content.clientHeight,
        };
      });
      expect(bounds.reportBottom).toBeLessThanOrEqual(bounds.sidebarBottom);
      expect(bounds.contentBottom).toBeLessThanOrEqual(bounds.sidebarBottom);
      expect(bounds.contentHeight).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: info.outputPath(`masking-open-${width}.png`), fullPage: true });
      await page.getByText("Masking details", { exact: true }).click();
      await expect(report).not.toBeVisible();
    });
  }
}

test("public masking waits for the recording to load", async ({ page }) => {
  const fixture = recording();
  await openProof(page, "public", fixture);
  let finishLoading = () => {};
  const loading = new Promise<void>((resolve) => {
    finishLoading = resolve;
  });
  await page.route(`${origin}/api/**/manifest`, async (route) => {
    await loading;
    await route.fulfill({ json: fixture.manifest });
  });
  await page.getByRole("button", { name: "Watch session" }).click();
  await expect(page.locator(".player-status")).toHaveText("loading");
  await expect(page.locator(".public-player-masking")).toHaveCount(0);
  finishLoading();
  await checkMaskingDisclosure(page, /The recorder reports input values masked/, 1280);
});

async function checkMaskingDisclosure(page: Page, text: string | RegExp, width: number) {
  const information = page.getByRole("region", { name: "Session information" });
  const summary = information.getByText("Masking details", { exact: true });
  await expect(summary).toBeVisible();
  await expect(information.getByText(text)).not.toBeVisible();
  if (width === 390) await summary.tap();
  else {
    await summary.focus();
    await page.keyboard.press("Enter");
  }
  await expect(information.getByText(text)).toBeVisible();
  if (width === 390) await summary.tap();
  else await page.keyboard.press("Space");
  await expect(information.getByText(text)).not.toBeVisible();
}

// The timeline must scroll within the player height, even when it has many rows.
async function compactReplayLayout(page: Page, width: number): Promise<string[]> {
  return page.evaluate((width) => {
    const controls = document.querySelector("[data-testid='replay-controls']")!;
    const card = controls.parentElement!;
    const sidebar = card.parentElement!.querySelector("aside")!;
    const viewport = sidebar.querySelector("[data-slot='scroll-area-viewport']")!;
    const cardBounds = card.getBoundingClientRect();
    const sidebarBounds = sidebar.getBoundingClientRect();
    const failures = [];
    if (Math.abs(cardBounds.bottom - controls.getBoundingClientRect().bottom) > 2)
      failures.push("Empty space below playback controls");
    if (width >= 1024 && Math.abs(sidebarBounds.height - cardBounds.height) > 2)
      failures.push("Timeline does not match player height");
    if (width < 1024 && viewport.clientHeight > 240)
      failures.push("Mobile timeline exceeds its height limit");
    if (viewport.scrollHeight <= viewport.clientHeight)
      failures.push("Long timeline does not scroll");
    return failures;
  }, width);
}

async function replayFitsCard(page: Page, surface: string): Promise<string[]> {
  return page.evaluate((surface) => {
    const stage = document.querySelector(
      surface === "public" ? ".public-player-stage" : "[data-testid='replay-stage']",
    )!;
    const frame = stage.querySelector("iframe")!;
    const card = stage.parentElement!;
    const checks = [
      ["recording inside stage", frame, stage],
      ["stage inside card", stage, card],
    ] as const;
    return checks.flatMap(([label, child, parent]) => {
      if (!child || !parent) return [`${label}: missing element`];
      const inner = child.getBoundingClientRect();
      const outer = parent.getBoundingClientRect();
      return inner.width > 0 &&
        inner.height > 0 &&
        inner.left >= outer.left - 1 &&
        inner.right <= outer.right + 1 &&
        inner.top >= outer.top - 1 &&
        inner.bottom <= outer.bottom + 1
        ? []
        : [label];
    });
  }, surface);
}

function recording() {
  const batches = ["Catalog page", "Checkout page"].map((title, index) => {
    const t = 1000 + index * 100;
    const node = {
      type: 0,
      id: 1,
      childNodes: [
        {
          type: 2,
          id: 2,
          tagName: "html",
          attributes: {},
          childNodes: [
            { type: 2, id: 3, tagName: "head", attributes: {}, childNodes: [] },
            {
              type: 2,
              id: 4,
              tagName: "body",
              attributes: { style: "background:white;color:black" },
              childNodes: [
                {
                  type: 2,
                  id: 5,
                  tagName: "h1",
                  attributes: {},
                  childNodes: [{ type: 3, id: 6, textContent: title }],
                },
              ],
            },
          ],
        },
      ],
    };
    const events = [
      { type: 4, timestamp: t, data: { href: "https://example.test/", width: 1000, height: 700 } },
      { type: 2, timestamp: t + 1, data: { node, initialOffset: { top: 0, left: 0 } } },
      { type: 5, timestamp: 2000, data: { tag: "done", payload: {} } },
    ];
    return encodeIngestBody(
      {
        v: 1,
        s: "session",
        tab: `opaque-tab-${index ? "b" : "a"}`,
        seq: 0,
        t0: t,
        t1: 2000,
        e: [],
        checkpointTimestamps: [t + 1],
      },
      new TextEncoder().encode(JSON.stringify(events)),
    );
  });
  const segment = buildSegment(batches);
  const manifest: SessionManifest = {
    v: 1,
    sessionId: "session",
    projectId: "project",
    orgId: "org",
    startedAt: 1000,
    endedAt: 2000,
    durationMs: 1000,
    bytes: segment.length,
    flags: 0,
    attrs: { entryUrl: "/catalog" },
    counts: { batches: 2, events: 4, errors: 1, clicks: 0, navs: 3, rages: 0 },
    segments: [
      {
        key: "p/project/session/seg-000001.ors",
        bytes: segment.length,
        t0: 1000,
        t1: 2000,
        batches: 2,
        checkpoints: [
          { tab: "opaque-tab-a", timestamp: 1001, batch: 0 },
          { tab: "opaque-tab-b", timestamp: 1101, batch: 1 },
        ],
      },
    ],
    timeline: [
      { t: 1000, k: "nav", tab: "opaque-tab-a", d: "/catalog" },
      { t: 1100, k: "nav", tab: "opaque-tab-b", d: "/checkout" },
      { t: 1700, k: "nav", tab: "opaque-tab-b", d: "/checkout/review" },
      { t: 1800, k: "error", tab: "opaque-tab-b", d: "Checkout error" },
      ...Array.from({ length: 40 }, (_, index) => ({
        t: 1801 + index,
        k: "click" as const,
        tab: "opaque-tab-b",
        d: `Timeline event ${index + 1}`,
      })),
      { t: 1950, k: "click", tab: "opaque-tab-b", d: "Final timeline event" },
    ],
    domMaskingSummary: {
      coverage: "complete",
      policyCount: 1,
      inputs: "all",
      text: "selected",
      canvas: false,
    },
    domMasking: {
      v: 1,
      unknownBatches: 0,
      overflowBatches: 0,
      policies: [
        {
          batches: 2,
          policy: {
            v: 1,
            defaultsVersion: 1,
            inputs: "all",
            text: "selected",
            localRules: { text: true, block: false, ignore: false },
            canvas: false,
            rulesFingerprint: "a".repeat(64),
          },
        },
      ],
    },
  };
  const data: PublicPageData = {
    version: 1,
    publicId: "pub_test",
    publicUrl: `${origin}/p/pub_test`,
    projectName: "Architecture verification",
    generatedAt: 1000,
    analyticsStatus: "pending",
    analytics: {
      sessions: 42,
      averageDurationMs: 1000,
      p50DurationMs: 1000,
      clicks: 0,
      pagesPerSession: 2,
      pagesCoveredSessions: 42,
      ragePercent: 0,
      quickBackPercent: 0,
      countries: [],
      devices: [],
      browsers: [],
      operatingSystems: [],
      entryPages: [],
    },
    recordings: [
      {
        replayId: "session",
        position: 0,
        operatingSystem: "macOS",
        errors: 1,
        startedAt: 1000,
        durationMs: 1000,
        entryPath: "/catalog",
        clicks: 0,
        pages: 2,
        rages: 0,
        country: "US",
        device: "desktop",
        browser: "Chrome",
      },
    ],
  };
  return { manifest, segment, data };
}
