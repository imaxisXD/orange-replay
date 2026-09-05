import { expect, test, type Page } from "@playwright/test";
import { buildSegment, encodeIngestBody } from "../../../packages/shared/src/wire.ts";
import type { PublicPageData, SessionManifest } from "../../../packages/shared/src/types.ts";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

const origin = process.env.SDK_VERIFY_ORIGIN!;
const helper = `/@fs${resolve("../../apps/dashboard/tests/architecture-proof.tsx")}`;
const preamble = `<script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;</script>`;

for (const width of [1280, 390]) {
  test.describe(`${width}px input`, () => {
    test.use({ hasTouch: width === 390 });
    for (const surface of ["private", "demo", "public", "analytics", "settings"]) {
      test(`${surface}: tab journeys and status at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const { manifest, segment, data } = recording();
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
          await expect(page.getByText(/The recorder reports input values masked/)).toBeVisible();
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
  });
}

async function replayFitsCard(page: Page, surface: string): Promise<string[]> {
  return page.evaluate((surface) => {
    const stage = document.querySelector(
      surface === "public" ? ".public-player-stage" : "[data-testid='replay-stage']",
    )!;
    const frame = stage.querySelector("iframe")!;
    const card = stage.parentElement!;
    const masking = card.querySelector(
      surface === "public" ? ".public-player-masking" : "[data-slot='masking-details']",
    )!;
    const checks = [
      ["recording inside stage", frame, stage],
      ["stage inside card", stage, card],
      ["masking inside card", masking, card],
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
