import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { buildSegment, encodeIngestBody } from "../../../packages/shared/src/wire.ts";
import type { PublicPageData, SessionManifest } from "../../../packages/shared/src/types.ts";
import type {
  SessionHead,
  SessionListItem,
} from "../../../packages/shared/src/session-contract.ts";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { build } from "vite-plus";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";

const appOrigin = "http://orange-replay.production.test";
const dashboardDist = resolve(process.env["PLAYBACK_BUILD_DIR"] ?? "../../apps/dashboard/dist");
const publicBundle = resolve(dashboardDist, "public/public-page.js");
const syntheticProjectId = "project_prod";
const currentSessionId = "session_current";
const legacySessionId = "session_legacy";
const browserErrorsByPage = new WeakMap<Page, string[]>();

let rendererDirectory: string;
let renderPublicPage: (data: PublicPageData) => Promise<ReadableStream<Uint8Array>>;

test.beforeAll(async () => {
  rendererDirectory = await mkdtemp(resolve(tmpdir(), "orange-replay-public-renderer-"));
  // Use the real server renderer. Playwright's JSX transform is for locators,
  // so compile the React server entry before importing it into this harness.
  await build({
    configFile: false,
    logLevel: "error",
    build: {
      ssr: resolve("../../apps/public-page/src/server.tsx"),
      outDir: rendererDirectory,
      emptyOutDir: false,
      rolldownOptions: { output: { entryFileNames: "server.mjs" } },
    },
    ssr: { noExternal: true },
  });
  ({ renderPublicPage } = await import(
    pathToFileURL(resolve(rendererDirectory, "server.mjs")).href
  ));
});

test.afterAll(async () => {
  if (rendererDirectory) await rm(rendererDirectory, { recursive: true, force: true });
});

test("private full view plays the current production bundle recording", async ({ page }) => {
  const fixture = syntheticFixture();
  await installProductionRoutes(page, fixture);
  await openProductionApp(page, `/projects/${syntheticProjectId}/sessions/${currentSessionId}`);

  await expect(page.getByRole("heading", { name: "/current", exact: true })).toBeVisible();
  await expectReplayText(page, "Production replay current");
  await exerciseDashboardPlayback(page, "Production replay current");
  await expectNoPlaybackErrors(page);
});

test("sessions page embedded player switches selection in the production bundle", async ({
  page,
}) => {
  const fixture = syntheticFixture();
  await installProductionRoutes(page, fixture);
  await openProductionApp(page, `/projects/${syntheticProjectId}/sessions`);

  const row = page.locator(`[data-session-id="${currentSessionId}"]`);
  await expect(row).toContainText("/current");
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/sessions\\?selected=${currentSessionId}$`));
  await expectReplayText(page, "Production replay current");
  await exerciseDashboardPlayback(page, "Production replay current");
  await expectNoPlaybackErrors(page);
});

test("demo full view plays a legacy manifest without tab or checkpoint metadata", async ({
  page,
}) => {
  const fixture = syntheticFixture();
  await installProductionRoutes(page, fixture);
  await openProductionApp(page, `/demo/sessions/${legacySessionId}`);

  await expect(page.getByRole("heading", { name: "/legacy", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Replay tab" })).toHaveCount(0);
  await expectReplayText(page, "Production replay legacy");
  await exerciseDashboardPlayback(page, "Production replay legacy");
  await expectNoPlaybackErrors(page);
});

test("public page built app plays a shared recording", async ({ page }) => {
  if (!existsSync(publicBundle)) {
    throw new Error(
      `Missing built public page bundle at ${publicBundle}. Run vp run e2e:production so the dashboard and public page are built before this test.`,
    );
  }

  const fixture = syntheticFixture();
  await installProductionRoutes(page, fixture);
  await page.goto(`${appOrigin}/p/pub_production`);

  await expect(page.getByRole("heading", { name: "Production Replay" })).toBeVisible();
  await page.getByRole("button", { name: "Watch session" }).click();
  await expectReplayText(page, "Production replay current");
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled();
  await page.getByRole("button", { name: "Play" }).click();
  await expectReplayText(page, "Production replay current");
  await expectNoPlaybackErrors(page);
});

test("optional local recording directory plays in the production private full view", async ({
  page,
}, info) => {
  const recordingDir = process.env["PLAYBACK_RECORDING_DIR"];
  test.skip(
    recordingDir === undefined || recordingDir.trim().length === 0,
    "Set PLAYBACK_RECORDING_DIR to a directory with manifest.json and .ors files.",
  );

  const fixture = await fixtureFromRecordingDir(recordingDir!);
  await installProductionRoutes(page, fixture);
  await openProductionApp(
    page,
    `/projects/${fixture.projectId}/sessions/${fixture.primarySessionId}`,
  );

  await expectReplayFrameReady(page);
  await page
    .getByTestId("replay-stage")
    .screenshot({ path: info.outputPath("actual-replay-start.png") });
  await maybeSwitchReplayTabs(page);
  const timeline = page.getByRole("slider", { name: "Replay timeline" });
  await expect(timeline).toBeVisible();
  const max = await sliderValue(timeline, "aria-valuemax");
  await timeline.focus();
  await page.keyboard.press("Home");
  await expect.poll(() => sliderValue(timeline, "aria-valuenow")).toBe(0);
  await expectReplayFrameReady(page);
  await timeline.click({ position: { x: 180, y: 13 } });
  await expect.poll(() => sliderValue(timeline, "aria-valuenow")).toBeGreaterThan(0);
  expect(await sliderValue(timeline, "aria-valuenow")).toBeLessThan(max);
  await expectReplayFrameReady(page);
  await page
    .getByTestId("replay-stage")
    .screenshot({ path: info.outputPath("actual-replay-middle.png") });
  await timeline.press("End");
  await expect.poll(() => sliderValue(timeline, "aria-valuenow")).toBe(max);
  await expectReplayFrameReady(page);
  await page.getByTestId("replay-stage").screenshot({
    path: info.outputPath("actual-replay-stage.png"),
  });
  await expectNoPlaybackErrors(page);
});

interface ReplayFixture {
  manifests: Map<string, SessionManifest>;
  primarySessionId: string;
  projectId: string;
  publicData: PublicPageData;
  segments: Map<string, Uint8Array>;
}

async function installProductionRoutes(page: Page, fixture: ReplayFixture): Promise<void> {
  const browserErrors: string[] = [];
  browserErrorsByPage.set(page, browserErrors);
  page.on("pageerror", (error) => browserErrors.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      browserErrors.push(`console error: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    browserErrors.push(`request failed: ${request.url()} ${failure?.errorText ?? ""}`.trim());
  });
  await page.exposeFunction("__recordProductionReplayError", (message: string) => {
    browserErrors.push(message);
  });
  await page.addInitScript(() => {
    const record = (message: string) => {
      void (
        window as unknown as {
          __recordProductionReplayError?: (message: string) => Promise<void>;
        }
      ).__recordProductionReplayError?.(message);
    };
    window.addEventListener("error", (event) => {
      record(`window error: ${event.message}`);
    });
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "unknown promise rejection";
      record(`unhandled rejection: ${message}`);
    });
    const OriginalWorker = window.Worker;
    window.Worker = class ProductionReplayTrackedWorker extends OriginalWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.addEventListener("error", (event) => {
          record(`worker error: ${event.message}`);
        });
        this.addEventListener("messageerror", () => {
          record("worker message error");
        });
      }
    };
  });

  await page.route("**/*", (route) => fulfillProductionRoute(route, fixture));
}

async function fulfillProductionRoute(route: Route, fixture: ReplayFixture): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin !== appOrigin) {
    await route.fulfill({ status: 404, body: "unexpected external request" });
    return;
  }

  const path = decodeURIComponent(url.pathname);
  if (path.startsWith("/api/v1/")) {
    await fulfillApiRoute(route, path, fixture);
    return;
  }
  if (path === "/p/pub_production") {
    await route.fulfill({
      contentType: "text/html",
      body: await new Response(await renderPublicPage(fixture.publicData)).text(),
    });
    return;
  }

  await fulfillStaticRoute(route, path);
}

async function fulfillApiRoute(route: Route, path: string, fixture: ReplayFixture): Promise<void> {
  if (path === "/api/v1/account") {
    await route.fulfill({ json: accountResponse(fixture.projectId) });
    return;
  }
  if (path === "/api/v1/demo") {
    await route.fulfill({
      json: { projectId: fixture.projectId, recorderKey: `or_live_${"a".repeat(32)}` },
    });
    return;
  }
  if (path === "/api/v1/public-pages/pub_production") {
    await route.fulfill({ json: fixture.publicData });
    return;
  }

  const publicReplay = path.match(
    /^\/api\/v1\/public-pages\/([^/]+)\/replays\/([^/]+)\/(manifest|segments\/([^/]+))$/,
  );
  if (publicReplay !== null) {
    const sessionId = publicReplay[2] ?? "";
    const manifest = fixture.manifests.get(sessionId);
    if (manifest === undefined) {
      await route.fulfill({ status: 404, json: { error: "not_found" } });
      return;
    }
    if (publicReplay[3] === "manifest") {
      await route.fulfill({ json: manifest });
      return;
    }
    await fulfillSegment(route, fixture, sessionId, publicReplay[4] ?? "");
    return;
  }

  const projectSessions = path.match(
    /^\/api\/v1\/projects\/([^/]+)\/(sessions|session-heads)(?:\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?)?$/,
  );
  if (projectSessions !== null) {
    const routeKind = projectSessions[2];
    const sessionId = projectSessions[3];
    const child = projectSessions[4];
    const segmentName = projectSessions[5];
    if (routeKind === "sessions" && sessionId === undefined) {
      await route.fulfill({ json: listSessionsResponse([...fixture.manifests.values()]) });
      return;
    }
    if (routeKind === "session-heads" && sessionId === undefined) {
      await route.fulfill({ json: { sessions: [] } });
      return;
    }
    const manifest = sessionId === undefined ? undefined : fixture.manifests.get(sessionId);
    if (manifest === undefined) {
      await route.fulfill({ status: 404, json: { error: "not_found" } });
      return;
    }
    if (child === "state") {
      await route.fulfill({ json: sessionHead(manifest) });
      return;
    }
    if (child === "manifest") {
      await route.fulfill({ json: manifest });
      return;
    }
    if (child === "segments" && sessionId !== undefined && segmentName !== undefined) {
      await fulfillSegment(route, fixture, sessionId, segmentName);
      return;
    }
  }

  const stats = path.match(/^\/api\/v1\/projects\/([^/]+)\/stats$/);
  if (stats !== null) {
    await route.fulfill({ json: statsResponse() });
    return;
  }

  await route.fulfill({ status: 404, json: { error: "not_found" } });
}

async function fulfillSegment(
  route: Route,
  fixture: ReplayFixture,
  sessionId: string,
  rawName: string,
): Promise<void> {
  const name = decodeURIComponent(rawName);
  const segment = fixture.segments.get(segmentMapKey(sessionId, name));
  if (segment === undefined) {
    await route.fulfill({ status: 404, json: { error: "not_found" } });
    return;
  }
  await route.fulfill({
    body: Buffer.from(segment),
    contentType: "application/octet-stream",
    headers: { "content-length": String(segment.byteLength) },
  });
}

async function fulfillStaticRoute(route: Route, path: string): Promise<void> {
  const filePath = staticFilePath(path);
  try {
    const body = await readFile(filePath);
    await route.fulfill({
      body,
      contentType: contentType(filePath),
    });
  } catch {
    await route.fulfill({ status: 404, body: `missing static file: ${path}` });
  }
}

function staticFilePath(path: string): string {
  if (path === "/" || isDashboardRoute(path)) return resolve(dashboardDist, "index.html");
  const cleanPath = path.replace(/^\/+/, "");
  return resolve(dashboardDist, cleanPath);
}

function isDashboardRoute(path: string): boolean {
  return (
    path === "/projects" ||
    path.startsWith("/projects/") ||
    path === "/demo" ||
    path.startsWith("/demo/") ||
    path === "/login"
  );
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    case ".ico":
      return "image/x-icon";
    case ".js":
      return "text/javascript";
    case ".json":
    case ".webmanifest":
      return "application/json";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function openProductionApp(page: Page, path: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${appOrigin}${path}`);
}

async function exerciseDashboardPlayback(page: Page, expectedText: string): Promise<void> {
  const timeline = page.getByRole("slider", { name: "Replay timeline" });
  await expect(timeline).toBeVisible();
  const max = await sliderValue(timeline, "aria-valuemax");
  await page.getByRole("button", { name: "Play replay" }).click();
  await expectReplayText(page, expectedText);
  const pause = page.getByRole("button", { name: "Pause replay" });
  if (await pause.isVisible()) await pause.click();
  await timeline.focus();
  await page.keyboard.press("End");
  await expect.poll(() => sliderValue(timeline, "aria-valuenow")).toBe(max);
  await expectReplayText(page, expectedText);
  await page.keyboard.press("Home");
  await expect.poll(() => sliderValue(timeline, "aria-valuenow")).toBe(0);
  await expectReplayText(page, expectedText);
}

async function expectReplayText(page: Page, expectedText: string): Promise<void> {
  try {
    await expect
      .poll(() => replayText(page), {
        message: `replay iframe should contain ${expectedText}`,
        timeout: 20_000,
      })
      .toContain(expectedText);
  } catch (error) {
    throw new Error(await playbackFailureMessage(page, error));
  }
}

async function expectReplayFrameReady(page: Page): Promise<void> {
  try {
    await expect
      .poll(() => replayFrameState(page), {
        message: "replay iframe should render document content",
        timeout: 30_000,
      })
      .toEqual({ hasFrame: true, hasBodyText: true });
  } catch (error) {
    throw new Error(await playbackFailureMessage(page, error));
  }
}

async function expectNoPlaybackErrors(page: Page): Promise<void> {
  await expect(page.getByText("Could not play replay")).toHaveCount(0);
  await expect(page.locator(".player-error")).toHaveCount(0);
  const errors = browserErrorsByPage.get(page) ?? [];
  expect(errors).toEqual([]);
}

async function maybeSwitchReplayTabs(page: Page): Promise<void> {
  const tab = page.getByRole("combobox", { name: "Replay tab" });
  if ((await tab.count()) === 0) return;

  await tab.click();
  const secondTab = page.getByRole("option", { name: /Tab 2/ });
  if ((await secondTab.count()) === 0) {
    await page.keyboard.press("Escape");
    return;
  }
  await secondTab.click();
  await expectReplayFrameReady(page);
  await tab.click();
  await page.getByRole("option", { name: /Tab 1/ }).click();
  await expectReplayFrameReady(page);
}

async function replayText(page: Page): Promise<string> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLIFrameElement>(".replayer-wrapper iframe")]
      .map((frame) => frame.contentDocument?.body?.innerText ?? "")
      .join("\n"),
  );
}

async function replayFrameState(page: Page): Promise<{ hasFrame: boolean; hasBodyText: boolean }> {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>(".replayer-wrapper iframe");
    const text = frame?.contentDocument?.body?.innerText.trim() ?? "";
    return { hasFrame: frame !== null, hasBodyText: text.length > 0 };
  });
}

async function sliderValue(slider: Locator, attribute: "aria-valuemax" | "aria-valuenow") {
  const value = Number(await slider.getAttribute(attribute));
  if (!Number.isFinite(value)) throw new Error(`Replay timeline ${attribute} is missing.`);
  return value;
}

async function playbackFailureMessage(page: Page, error: unknown): Promise<string> {
  const browserErrors = browserErrorsByPage.get(page) ?? [];
  const playerErrors = await page
    .locator("text=Could not play replay")
    .allTextContents()
    .catch(() => []);
  const message = error instanceof Error ? error.message : String(error);
  const details = [...browserErrors, ...playerErrors].join("\n");
  return details.length === 0
    ? message
    : `${message}\n\nCaptured browser/player errors:\n${details}`;
}

function syntheticFixture(): ReplayFixture {
  const current = recording({
    entryPath: "/current",
    heading: "Production replay current",
    legacyManifest: false,
    sessionId: currentSessionId,
    tabId: "tab_current",
  });
  const legacy = recording({
    entryPath: "/legacy",
    heading: "Production replay legacy",
    legacyManifest: true,
    sessionId: legacySessionId,
    tabId: "tab_legacy",
  });
  const segments = new Map<string, Uint8Array>([
    [segmentMapKey(current.manifest.sessionId, segmentName(current.manifest)), current.segment],
    [segmentMapKey(legacy.manifest.sessionId, segmentName(legacy.manifest)), legacy.segment],
  ]);
  const publicData = publicPageData(current.manifest);
  return {
    manifests: new Map([
      [current.manifest.sessionId, current.manifest],
      [legacy.manifest.sessionId, legacy.manifest],
    ]),
    primarySessionId: current.manifest.sessionId,
    projectId: syntheticProjectId,
    publicData,
    segments,
  };
}

function recording(options: {
  entryPath: string;
  heading: string;
  legacyManifest: boolean;
  sessionId: string;
  tabId: string;
}): { manifest: SessionManifest; segment: Uint8Array } {
  const startedAt = 10_000;
  const snapshotAt = startedAt + 1;
  const finalAt = startedAt + 10_000;
  const events = [
    {
      type: 4,
      timestamp: startedAt,
      data: {
        href: `https://customer.example${options.entryPath}`,
        width: 1_000,
        height: 700,
      },
    },
    {
      type: 2,
      timestamp: snapshotAt,
      data: {
        initialOffset: { left: 0, top: 0 },
        node: replayDocument(options.heading),
      },
    },
    {
      type: 3,
      timestamp: startedAt + 500,
      data: {
        source: 1,
        positions: [{ x: 240, y: 120, id: 7, timeOffset: 0 }],
      },
    },
    { type: 5, timestamp: finalAt, data: { tag: "done", payload: {} } },
  ];
  const batch = encodeIngestBody(
    {
      v: 1,
      s: options.sessionId,
      tab: options.tabId,
      seq: 0,
      t0: startedAt,
      t1: finalAt,
      e: [],
      checkpointTimestamps: [snapshotAt],
    },
    new TextEncoder().encode(JSON.stringify(events)),
  );
  const segment = buildSegment([batch]);
  const timelineTab = options.legacyManifest ? undefined : options.tabId;
  return {
    segment,
    manifest: {
      v: 1,
      sessionId: options.sessionId,
      projectId: syntheticProjectId,
      orgId: "org_prod",
      startedAt,
      endedAt: finalAt,
      durationMs: finalAt - startedAt,
      bytes: segment.length,
      flags: 0,
      attrs: {
        browser: "Chrome",
        country: "US",
        device: "desktop",
        entryUrl: options.entryPath,
        os: "macOS",
        pageCount: 1,
        urlCount: 1,
      },
      counts: { batches: 1, events: events.length, errors: 0, clicks: 0, navs: 1, rages: 0 },
      segments: [
        {
          key: `p/${syntheticProjectId}/${options.sessionId}/seg-000001.ors`,
          bytes: segment.length,
          t0: startedAt,
          t1: finalAt,
          batches: 1,
          ...(options.legacyManifest
            ? {}
            : { checkpoints: [{ tab: options.tabId, timestamp: snapshotAt, batch: 0 }] }),
        },
      ],
      timeline: [
        {
          t: startedAt,
          k: "nav",
          d: options.entryPath,
          ...(timelineTab === undefined ? {} : { tab: timelineTab }),
        },
      ],
      domMaskingSummary: {
        coverage: "complete",
        policyCount: 1,
        canvas: false,
        inputs: "all",
        text: "selected",
      },
      domMasking: {
        v: 1,
        unknownBatches: 0,
        overflowBatches: 0,
        policies: [
          {
            batches: 1,
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
    },
  };
}

function replayDocument(heading: string) {
  return {
    type: 0,
    id: 1,
    childNodes: [
      {
        type: 2,
        id: 2,
        tagName: "html",
        attributes: {},
        childNodes: [
          {
            type: 2,
            id: 3,
            tagName: "head",
            attributes: {},
            childNodes: [
              {
                type: 2,
                id: 4,
                tagName: "style",
                attributes: {},
                childNodes: [
                  {
                    type: 3,
                    id: 5,
                    isStyle: true,
                    textContent:
                      "body{margin:0;font:16px Arial,sans-serif;color:#111;background:#fff}main{padding:32px}.card{border:2px solid #f5a623;padding:24px;min-height:220px}",
                  },
                ],
              },
            ],
          },
          {
            type: 2,
            id: 6,
            tagName: "body",
            attributes: {},
            childNodes: [
              {
                type: 2,
                id: 7,
                tagName: "main",
                attributes: {},
                childNodes: [
                  {
                    type: 2,
                    id: 8,
                    tagName: "section",
                    attributes: { class: "card" },
                    childNodes: [
                      {
                        type: 2,
                        id: 9,
                        tagName: "h1",
                        attributes: {},
                        childNodes: [{ type: 3, id: 10, textContent: heading }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function fixtureFromRecordingDir(recordingDir: string): Promise<ReplayFixture> {
  const root = resolve(recordingDir);
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")) as
    | SessionManifest
    | { manifest: SessionManifest };
  const sessionManifest = "manifest" in manifest ? manifest.manifest : manifest;
  const segments = new Map<string, Uint8Array>();
  await Promise.all(
    sessionManifest.segments.map(async (segment) => {
      const name = segmentNameFromKey(segment.key);
      segments.set(
        segmentMapKey(sessionManifest.sessionId, name),
        new Uint8Array(await readFile(resolve(root, name))),
      );
    }),
  );
  return {
    manifests: new Map([[sessionManifest.sessionId, sessionManifest]]),
    primarySessionId: sessionManifest.sessionId,
    projectId: sessionManifest.projectId,
    publicData: publicPageData(sessionManifest),
    segments,
  };
}

function listSessionsResponse(manifests: SessionManifest[]) {
  return {
    sessions: manifests.map(sessionListItem),
    nextBefore: null,
    warehouseVersion: 1,
    analyticsState: "fresh",
    analyticsDelivery: { state: "current", pendingExports: 0, oldestPendingAt: null, checkedAt: 1 },
    analyticsView: "latest",
  };
}

function sessionHead(manifest: SessionManifest): SessionHead {
  return {
    ...sessionListItem(manifest),
    activity: "complete",
    details_state: "exact",
    replay_source: "recorded",
  };
}

function sessionListItem(manifest: SessionManifest): SessionListItem {
  return {
    session_id: manifest.sessionId,
    project_id: manifest.projectId,
    org_id: manifest.orgId,
    started_at: Math.max(0, Math.round(manifest.startedAt)),
    ended_at: Math.max(0, Math.round(manifest.endedAt)),
    duration_ms: Math.max(0, Math.round(manifest.durationMs)),
    country: manifest.attrs.country ?? null,
    region: manifest.attrs.region ?? null,
    city: manifest.attrs.city ?? null,
    device: manifest.attrs.device ?? null,
    browser: manifest.attrs.browser ?? null,
    os: manifest.attrs.os ?? null,
    entry_url: manifest.attrs.entryUrl ?? null,
    url_count: manifest.attrs.urlCount ?? manifest.counts.navs,
    page_count: manifest.attrs.pageCount ?? manifest.counts.navs,
    analytics_version: 1,
    max_scroll_depth: null,
    quick_backs: null,
    interaction_time_ms: null,
    activity_hist: null,
    clicks: manifest.counts.clicks,
    errors: manifest.counts.errors,
    rages: manifest.counts.rages,
    navs: manifest.counts.navs,
    bytes: manifest.bytes,
    segment_count: manifest.segments.length,
    flags: manifest.flags,
    manifest_key: `p/${manifest.projectId}/${manifest.sessionId}/manifest.json`,
    expires_at: manifest.endedAt + 90 * 24 * 60 * 60 * 1_000,
    has_checkpoint: hasCheckpoint(manifest),
  };
}

function hasCheckpoint(manifest: SessionManifest): boolean | null {
  if (manifest.segments.some((segment) => (segment.checkpoints ?? []).length > 0)) return true;
  return manifest.segments.some((segment) => segment.checkpoints === undefined) ? null : false;
}

function accountResponse(projectId: string) {
  return {
    user: {
      id: "user_prod",
      name: "Production Tester",
      email: "tester@example.com",
      emailVerified: true,
      image: null,
      role: "user",
    },
    activeWorkspaceId: "workspace_prod",
    isAdmin: false,
    workspaces: [
      {
        id: "workspace_prod",
        name: "Production Replay",
        slug: "production-replay",
        role: "owner",
        projects: [
          {
            id: projectId,
            name: "Production Replay",
            role: "owner",
            websiteOrigin: "https://customer.example",
            journeyDomain: "customer.example",
          },
        ],
      },
    ],
  };
}

function statsResponse() {
  const filter = {};
  const numberValue = (value: number) => ({ value, filter });
  const optionalNumberValue = (value: number | null) => ({ value, filter });
  const pageFilter = { has_page_coverage: true };
  const insightFilter = { has_insights: true };
  const rageFilter = { has_rage: true };
  const quickBackFilter = { has_quick_back: true };
  return {
    filter,
    sessions: numberValue(2),
    duration: {
      average: numberValue(900),
      p50: numberValue(900),
    },
    clicks: numberValue(0),
    pagesPerSession: {
      value: 1,
      filter: pageFilter,
      includedSessions: { value: 2, filter: pageFilter },
      totalSessions: numberValue(2),
    },
    insights: {
      ragePercent: { value: 0, filter: rageFilter },
      quickBackPercent: { value: 0, filter: quickBackFilter },
      averageInteractionTimeMs: { value: null, filter: insightFilter },
      averageMaxScrollDepth: { value: null, filter: insightFilter },
      includedSessions: { value: 0, filter: insightFilter },
      totalSessions: numberValue(2),
    },
    breakdowns: {
      country: [],
      region: [],
      city: [],
      device: [],
      browser: [],
      os: [],
      entryPage: [],
    },
    errors: [],
    liveNow: optionalNumberValue(0),
    liveNowState: "available",
    warehouseVersion: 1,
    analyticsState: "fresh",
    analyticsDelivery: { state: "current", pendingExports: 0, oldestPendingAt: null, checkedAt: 1 },
    analyticsView: "latest",
  };
}

function publicPageData(manifest: SessionManifest): PublicPageData {
  return {
    version: 1,
    publicId: "pub_production",
    publicUrl: `${appOrigin}/p/pub_production`,
    projectName: "Production Replay",
    generatedAt: 1,
    analyticsStatus: "current",
    analytics: {
      sessions: 1,
      averageDurationMs: manifest.durationMs,
      p50DurationMs: manifest.durationMs,
      clicks: manifest.counts.clicks,
      pagesPerSession: manifest.attrs.pageCount ?? null,
      pagesCoveredSessions: manifest.attrs.pageCount === undefined ? 0 : 1,
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
        replayId: manifest.sessionId,
        position: 0,
        startedAt: Math.max(0, Math.round(manifest.startedAt)),
        durationMs: Math.max(0, Math.round(manifest.durationMs)),
        entryPath: manifest.attrs.entryUrl?.startsWith("/") ? manifest.attrs.entryUrl : "/",
        country: manifest.attrs.country ?? null,
        device: manifest.attrs.device ?? null,
        browser: manifest.attrs.browser ?? null,
        operatingSystem: manifest.attrs.os ?? null,
        clicks: manifest.counts.clicks,
        errors: manifest.counts.errors,
        rages: manifest.counts.rages,
        pages: manifest.attrs.pageCount ?? null,
      },
    ],
  };
}

function segmentName(manifest: SessionManifest): string {
  const firstSegment = manifest.segments[0];
  if (firstSegment === undefined) throw new Error("Synthetic manifest has no segment.");
  return segmentNameFromKey(firstSegment.key);
}

function segmentNameFromKey(key: string): string {
  return key.split("/").at(-1) ?? key;
}

function segmentMapKey(sessionId: string, name: string): string {
  return `${sessionId}/${name}`;
}
