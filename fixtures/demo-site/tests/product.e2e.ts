import { readFile } from "node:fs/promises";
import {
  expect,
  test,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "@playwright/test";
import type { ProjectConfig } from "@orange-replay/shared";

const stateFile = new URL("../.playwright-state.json", import.meta.url);
const textSecret = "private alpha workspace";
const passwordSecret = "CorrectHorseOrange!42";
const liveAddedRowText = "Central warehouse added a fresh quality check.";

test.describe.configure({ mode: "serial" });

test("records, replays, masks, and follows a live session from the dashboard", async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const state = await readState();
  let recordedSessionId = "";
  let recordedSession: IndexedSession | null = null;
  let recordedStyleSignature: DemoStyleSignature | undefined;
  let dashboardContext: BrowserContext | undefined;
  let dashboardPage: Page | undefined;
  let liveContext: BrowserContext | undefined;
  let liveDashboardContext: BrowserContext | undefined;
  let livePage: Page | undefined;
  let liveDashboardPage: Page | undefined;
  let liveSessionsPage: Page | undefined;
  let liveSessionId = "";
  let stopLiveActions: (() => void) | undefined;

  try {
    await seedProject(state);

    await test.step("record -> list", async () => {
      const recordContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      const recordPage = await recordContext.newPage();

      try {
        const recording = await recordDemoSession(recordPage, state);
        recordedSessionId = recording.sessionId;
        recordedStyleSignature = recording.styleSignature;
      } finally {
        await recordContext.close();
      }

      await waitForFinalize(state, recordedSessionId);
      const indexed = await waitForIndexedSession(state, recordedSessionId);
      recordedSession = indexed.session;

      dashboardContext = await browser.newContext({ viewport: { width: 1100, height: 700 } });
      dashboardPage = await openDashboardPage(
        dashboardContext,
        state,
        `/projects/${state.projectId}/sessions`,
      );

      await expect(dashboardPage.locator("body")).not.toContainText(passwordSecret);

      const row = await waitForFirstSessionRow(dashboardPage);
      await expect(row).toContainText(entryPath(recordedSession.entry_url));
      await expect(row).toContainText(
        formatLocation(recordedSession.country, recordedSession.city),
      );
      await expect(row).toContainText(formatErrorCount(recordedSession.errors));
      await expect(row).toContainText(/\d+:\d{2}/);

      await row.click();
      await expect(row).toHaveAttribute("aria-selected", "true");
      await Promise.all([
        dashboardPage.waitForURL(
          new RegExp(
            `/projects/${escapeRegex(state.projectId)}/sessions/${escapeRegex(recordedSessionId)}$`,
          ),
        ),
        dashboardPage.getByRole("link", { name: "Open full view" }).click(),
      ]);
    });

    await test.step("playback with effects", async () => {
      const page = requirePage(dashboardPage);
      const initialFrame = await waitForReplayFrameWithText(
        page,
        "Warehouse stock timeline",
        20_000,
      );
      expect(recordedStyleSignature).toBeDefined();
      expect(await readDemoStyleSignature(initialFrame)).toEqual(recordedStyleSignature);

      await page.getByRole("button", { name: "Play replay" }).click();
      await expect(
        page.locator('[aria-label="Replay timeline"] span.bg-danger').first(),
      ).toBeVisible();

      const overlayCanvas = page.locator("canvas[aria-hidden='true']").first();
      await expect(overlayCanvas).toBeVisible();
      await expect
        .poll(async () => {
          return overlayCanvas.evaluate((element) => {
            const canvas = element as HTMLCanvasElement;
            return (
              canvas.width > 0 &&
              canvas.height > 0 &&
              window.getComputedStyle(canvas).position === "absolute"
            );
          });
        })
        .toBe(true);

      const replayCursor = page.locator(".replayer-mouse").first();
      await expect(replayCursor).toBeVisible();
      await expect
        .poll(async () => {
          return replayCursor.evaluate((element) => {
            const style = window.getComputedStyle(element);
            return {
              backgroundImage: style.backgroundImage,
              height: style.height,
              position: style.position,
              width: style.width,
            };
          });
        })
        .toMatchObject({
          height: "32px",
          position: "absolute",
          width: "32px",
        });
      expect(
        await replayCursor.evaluate((element) => window.getComputedStyle(element).backgroundImage),
      ).not.toBe("none");

      await expect.poll(async () => replayFitsInsideStage(page)).toBe(true);

      const replayGeometry = await readReplayGeometry(page);
      expect(replayGeometry).not.toBeNull();
      expect(replayGeometry?.scale).toBeLessThan(1);
      expect(
        Math.abs((replayGeometry?.leftGap ?? 0) - (replayGeometry?.rightGap ?? 0)),
      ).toBeLessThanOrEqual(4);

      const heatStrip = page.getByTestId("activity-heat-strip");
      await expect(heatStrip).toBeVisible();
      await expect
        .poll(() =>
          heatStrip.locator('[data-activity-count]:not([data-activity-count="0"])').count(),
        )
        .toBeGreaterThan(0);

      await expect(page.getByTestId("journey-breadcrumbs")).toBeVisible();
      const secondPageBreadcrumb = page
        .getByTestId("journey-breadcrumbs")
        .getByRole("button", { name: /page2/i });
      await expect(secondPageBreadcrumb).toBeVisible();

      const timeline = page.getByRole("slider", { name: "Replay timeline" });
      await timeline.click({ position: { x: 1, y: 13 } });
      const beforeJourney = readNumber(await timeline.getAttribute("aria-valuenow"));
      await secondPageBreadcrumb.click();
      await expect
        .poll(async () => readNumber(await timeline.getAttribute("aria-valuenow")))
        .toBeGreaterThan(beforeJourney);

      await expect(page.getByTestId("dead-click-marker").first()).toBeVisible();
      await expect(
        page
          .locator("aside")
          .getByRole("button", { name: /dead click/i })
          .first(),
      ).toBeVisible();

      const pauseReplay = page.getByRole("button", { name: "Pause replay" });
      if (await pauseReplay.isVisible()) await pauseReplay.click();
      await timeline.press("End");
      await expect
        .poll(async () => readNumber(await timeline.getAttribute("aria-valuenow")))
        .toBe(readNumber(await timeline.getAttribute("aria-valuemax")));
      await page.getByTestId("first-error-button").click();
      await expect
        .poll(async () => readNumber(await timeline.getAttribute("aria-valuenow")))
        .toBe(0);

      await expect(page.getByRole("heading", { name: "Segments" })).toHaveCount(0);

      const errorRow = page
        .locator("aside")
        .getByRole("button")
        .filter({ hasText: /TypeError|run/i })
        .first();
      await expect(errorRow).toBeVisible();

      if (await pauseReplay.isVisible()) await pauseReplay.click();
      await timeline.press("End");
      await expect
        .poll(async () => readNumber(await timeline.getAttribute("aria-valuenow")))
        .toBe(readNumber(await timeline.getAttribute("aria-valuemax")));
      await errorRow.click();
      await expect
        .poll(async () => readNumber(await timeline.getAttribute("aria-valuenow")))
        .toBe(0);

      // The replayer rebuilds its iframe document on play/seek, and playback
      // may have advanced into the page2 portion of the recording by now —
      // re-resolve the frame and accept either page's copy.
      await waitForReplayFrameWithText(page, ["Warehouse stock timeline", "Back to board"], 20_000);
    });

    await test.step("masking proof at dashboard level", async () => {
      const page = requirePage(dashboardPage);
      const frame = await waitForReplayFrameWithText(
        page,
        ["Warehouse stock timeline", "Back to board"],
        20_000,
      );
      const frameHtml = await frame.evaluate(() => document.documentElement.outerHTML);

      expect(frameHtml).not.toContain(passwordSecret);
      await expect(page.locator("body")).not.toContainText(passwordSecret);
      await expect(page.locator("body")).not.toContainText(textSecret);
    });

    await test.step("live now", async () => {
      await seedProject(state);

      // Keep Sessions open before the visitor arrives. The polling window must
      // roll forward so a new recording appears without a page refresh.
      liveDashboardContext = await browser.newContext();
      liveSessionsPage = await openDashboardPage(
        liveDashboardContext,
        state,
        `/projects/${state.projectId}/sessions`,
      );

      liveContext = await browser.newContext();
      livePage = await liveContext.newPage();
      await livePage.goto(state.demoUrl);
      await expect(
        livePage.getByRole("heading", { name: "Signal Board starter kit" }),
      ).toBeVisible();
      liveSessionId = await readSessionId(livePage);
      stopLiveActions = startSmallLiveActions(livePage);

      liveDashboardPage = await openDashboardPage(
        liveDashboardContext,
        state,
        `/projects/${state.projectId}/live`,
      );

      await expect(liveSessionsPage.locator(`[data-session-id="${liveSessionId}"]`)).toBeVisible({
        timeout: 15_000,
      });

      const liveRow = await waitForFirstLiveRow(liveDashboardPage, 15_000);
      await expect(liveRow).toContainText("/");

      const firstElapsed = await liveRow.locator("span").last().innerText();
      await expect
        .poll(async () => readFirstLiveElapsed(requirePage(liveDashboardPage)), {
          timeout: 12_000,
        })
        .not.toBe(firstElapsed);
    });

    await test.step("two-context live watch", async () => {
      const sourcePage = requirePage(livePage);
      const watcherPage = requirePage(liveDashboardPage);
      const liveRow = await waitForFirstLiveRow(watcherPage, 5_000);

      await liveRow.click();
      await watcherPage.waitForURL(
        new RegExp(
          `/projects/${escapeRegex(state.projectId)}/sessions/${escapeRegex(liveSessionId)}$`,
        ),
      );
      await expect(watcherPage.getByText("LIVE", { exact: true })).toBeVisible();

      stopLiveActions?.();
      stopLiveActions = undefined;
      await sourcePage.getByRole("button", { name: "Add product row" }).click();

      const liveFrame = await waitForReplayFrameWithText(watcherPage, liveAddedRowText, 20_000);
      await expect(liveFrame.locator("body")).toContainText(liveAddedRowText);

      const stableReplayUrl = watcherPage.url();
      await sourcePage.close();

      const continuousRow = requirePage(liveSessionsPage).locator(
        `[data-session-id="${liveSessionId}"]`,
      );
      await expect(continuousRow).toBeVisible({ timeout: 10_000 });
      await expect(continuousRow).toContainText("Final details pending", { timeout: 7_000 });
      await expect(watcherPage.getByText("Final details pending", { exact: true })).toBeVisible({
        timeout: 7_000,
      });
      expect(watcherPage.url()).toBe(stableReplayUrl);
      await expect(
        (await waitForReplayFrameWithText(watcherPage, liveAddedRowText, 5_000)).locator("body"),
      ).toContainText(liveAddedRowText);

      // Presence has expired, but the history already received by the player
      // must stay reviewable while final details are still pending.
      const idleTimeline = watcherPage.getByRole("slider", { name: "Replay timeline" });
      await expect(idleTimeline).toHaveAttribute("aria-disabled", "false");
      await expect(watcherPage.getByRole("button", { name: "Play replay" })).toBeVisible();
      await idleTimeline.press("End");
      await expect
        .poll(async () => readNumber(await idleTimeline.getAttribute("aria-valuenow")))
        .toBeGreaterThan(0);
      await idleTimeline.press("Home");
      await expect
        .poll(async () => readNumber(await idleTimeline.getAttribute("aria-valuenow")))
        .toBe(0);
      await watcherPage.getByRole("button", { name: "Play replay" }).click();
      await expect
        .poll(async () => readNumber(await idleTimeline.getAttribute("aria-valuenow")))
        .toBeGreaterThan(0);
      const idlePause = watcherPage.getByRole("button", { name: "Pause replay" });
      if (await idlePause.isVisible()) await idlePause.click();
      await idleTimeline.press("End");
      await expect
        .poll(async () => readNumber(await idleTimeline.getAttribute("aria-valuenow")))
        .toBe(readNumber(await idleTimeline.getAttribute("aria-valuemax")));
      expect(watcherPage.url()).toBe(stableReplayUrl);
      await expect(
        (await waitForReplayFrameWithText(watcherPage, liveAddedRowText, 5_000)).locator("body"),
      ).toContainText(liveAddedRowText);

      // A fresh player opened in the old dark-gap window must rebuild from
      // already flushed segments plus any stored live tail. Idle review closes
      // this history socket before finalization, so watch the exact state poll
      // that must complete the recorded handoff.
      let routedLiveSocket = false;
      await watcherPage.routeWebSocket(/\/live\?ticket=/, (socket) => {
        routedLiveSocket = true;
        const server = socket.connectToServer();
        server.onMessage((message) => {
          if (typeof message === "string" && message.includes('"type":"finalized"')) {
            return;
          }
          socket.send(message);
        });
        // Keep the page-side socket open when the server closes so its normal
        // close callback cannot trigger the fallback early.
        server.onClose(() => undefined);
      });
      const exactStateFromPoll = watcherPage.waitForResponse(
        async (response) => {
          if (
            response.request().method() !== "GET" ||
            !response
              .url()
              .includes(`/api/v1/projects/${state.projectId}/sessions/${liveSessionId}/state`) ||
            !response.ok()
          ) {
            return false;
          }

          const body = (await response.json()) as {
            details_state?: unknown;
            replay_source?: unknown;
          };
          return body.details_state === "exact" && body.replay_source === "recorded";
        },
        { timeout: state.timings.closeMs + 20_000 },
      );
      await watcherPage.reload();
      await expect.poll(() => routedLiveSocket, { timeout: 7_000 }).toBe(true);
      await expect(watcherPage.getByText("Final details pending", { exact: true })).toBeVisible({
        timeout: 7_000,
      });
      expect(watcherPage.url()).toBe(stableReplayUrl);
      await expect(
        (await waitForReplayFrameWithText(watcherPage, liveAddedRowText, 7_000)).locator("body"),
      ).toContainText(liveAddedRowText);

      await waitForFinalize(state, liveSessionId);
      await waitForIndexedSession(state, liveSessionId);
      await exactStateFromPoll;
      await expect(continuousRow).toBeVisible({ timeout: 15_000 });
      await expect(continuousRow).not.toContainText("Final details pending", { timeout: 15_000 });
      await expect(continuousRow).toBeVisible();
      await expect(watcherPage.getByText("Final details pending", { exact: true })).not.toBeVisible(
        { timeout: 15_000 },
      );
      expect(watcherPage.url()).toBe(stableReplayUrl);
      await expect(watcherPage.getByRole("slider", { name: "Replay timeline" })).toHaveAttribute(
        "aria-disabled",
        "false",
      );
      await expect(
        (await waitForReplayFrameWithText(watcherPage, liveAddedRowText, 10_000)).locator("body"),
      ).toContainText(liveAddedRowText);
      await expect(watcherPage.getByRole("alert")).toHaveCount(0);
    });
  } finally {
    stopLiveActions?.();
    await Promise.allSettled([
      dashboardContext?.close(),
      liveDashboardContext?.close(),
      liveContext?.close(),
    ]);
  }
});

interface ServerState {
  workerUrl: string;
  demoUrl: string;
  dashboardUrl: string;
  sessionCookie: string;
  ingestKey: string;
  projectId: string;
  orgId: string;
  timings: {
    closeMs: number;
    segmentFlushMs: number;
  };
}

interface IndexedSession {
  session_id: string;
  entry_url: string | null;
  country: string | null;
  city: string | null;
  errors: number;
}

interface ConsumerSessionBody {
  session: IndexedSession | null;
  events: Record<string, unknown>[];
  usage: Record<string, unknown>[];
}

interface DebugBody {
  hasState: boolean;
  finalized: boolean;
}

interface ReplayGeometry {
  iframeLeft: number;
  iframeRight: number;
  iframeTop: number;
  iframeBottom: number;
  stageLeft: number;
  stageRight: number;
  stageTop: number;
  stageBottom: number;
  leftGap: number;
  rightGap: number;
  scale: number;
}

async function readState(): Promise<ServerState> {
  return JSON.parse(await readFile(stateFile, "utf8")) as ServerState;
}

async function seedProject(
  state: ServerState,
  overrides: Partial<Pick<ProjectConfig, "quotaState" | "sampleRate">> = {},
): Promise<void> {
  const config: ProjectConfig = {
    projectId: state.projectId,
    orgId: state.orgId,
    shard: 0,
    active: true,
    sampleRate: overrides.sampleRate ?? 1,
    allowedOrigins: ["*"],
    maskPolicyVersion: 1,
    quotaState: overrides.quotaState ?? "ok",
    retentionDays: 30,
  };

  const response = await fetch(`${state.workerUrl}/__test/ingest/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key: state.ingestKey,
      kv: true,
      config,
    }),
  });

  expect(response.status).toBe(200);
}

async function recordDemoSession(
  page: Page,
  state: ServerState,
): Promise<{ sessionId: string; styleSignature: DemoStyleSignature }> {
  await page.goto(state.demoUrl);
  await expect(page.getByRole("heading", { name: "Signal Board starter kit" })).toBeVisible();
  const sessionId = await readSessionId(page);
  const styleSignature = await readDemoStyleSignature(page);

  await page.getByLabel("Workspace name").fill(textSecret);
  await page.getByLabel("Admin password").fill(passwordSecret);
  await page.getByRole("button", { name: "Add product row" }).click();
  await page.getByRole("button", { name: "Show stock panel" }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  // Keep this no-op save separate from the later test error so the replay can
  // correctly identify it as a dead click.
  await page.waitForTimeout(700);
  await page.mouse.wheel(0, 1_800);

  const pageError = page.waitForEvent("pageerror");
  await page.getByRole("button", { name: "Trigger TypeError" }).click();
  await expect(pageError).resolves.toHaveProperty("message", expect.stringContaining("run"));

  await page.getByRole("link", { name: "Open order details" }).click();
  await page.waitForURL(/\/page2\.html/);
  await expect(page.getByRole("heading", { name: "Order details" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm checklist" }).click();
  await page.waitForTimeout(Math.min(1_000, state.timings.segmentFlushMs + 300));

  expect(await readSessionId(page)).toBe(sessionId);
  await page.close();
  return { sessionId, styleSignature };
}

interface DemoStyleSignature {
  body: Record<string, string>;
  topbar: Record<string, string>;
  hero: Record<string, string>;
  productPanel: Record<string, string>;
  actionButton: Record<string, string>;
  noteGrid: Record<string, string>;
}

async function readDemoStyleSignature(target: Page | Frame): Promise<DemoStyleSignature> {
  return target.evaluate(() => {
    const read = (selector: string, properties: string[]): Record<string, string> => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Missing demo element: ${selector}`);
      }

      const style = window.getComputedStyle(element);
      return Object.fromEntries(
        properties.map((property) => [property, style.getPropertyValue(property)]),
      );
    };

    return {
      body: read("body", ["color", "background-color", "font-family", "margin"]),
      topbar: read(".topbar", [
        "display",
        "position",
        "gap",
        "padding-left",
        "padding-top",
        "background-color",
        "border-bottom-width",
      ]),
      hero: read(".hero", [
        "display",
        "grid-template-columns",
        "gap",
        "min-height",
        "padding-top",
        "background-color",
        "border-top-width",
      ]),
      productPanel: read(".product-panel", [
        "display",
        "min-height",
        "padding-top",
        "background-color",
        "border-top-width",
      ]),
      actionButton: read("button", [
        "min-height",
        "border-radius",
        "padding-left",
        "color",
        "background-color",
      ]),
      noteGrid: read(".note-grid", ["display", "grid-template-columns", "gap", "margin-top"]),
    };
  });
}

async function readSessionId(page: Page): Promise<string> {
  await expect
    .poll(() => page.evaluate(() => window.__orangeReplay?.getSessionUrl() ?? ""))
    .toMatch(/\/sessions\/[^/]+\/[A-Za-z0-9_-]{16,64}$/);

  const sessionUrl = await page.evaluate(() => window.__orangeReplay?.getSessionUrl() ?? "");
  return new URL(sessionUrl).pathname.split("/").at(-1) ?? "";
}

async function waitForFinalize(state: ServerState, sessionId: string): Promise<void> {
  await poll(async () => {
    const response = await fetch(
      `${state.workerUrl}/__test/do/debug?projectId=${encodeURIComponent(
        state.projectId,
      )}&sessionId=${encodeURIComponent(sessionId)}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DebugBody;
    return body.hasState === false && body.finalized === true ? body : null;
  }, state.timings.closeMs + 15_000);
}

async function waitForIndexedSession(
  state: ServerState,
  sessionId: string,
): Promise<{
  session: IndexedSession;
  events: Record<string, unknown>[];
  usage: Record<string, unknown>[];
}> {
  return poll(async () => {
    const response = await fetch(
      `${state.workerUrl}/__test/consumer/session?id=${encodeURIComponent(sessionId)}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as ConsumerSessionBody;
    return body.session === null ? null : { ...body, session: body.session };
  }, 20_000);
}

async function openDashboardPage(
  context: BrowserContext,
  state: ServerState,
  path: string,
): Promise<Page> {
  const [name, ...valueParts] = state.sessionCookie.split("=");
  const value = valueParts.join("=");
  if (name === undefined || name.length === 0 || value.length === 0) {
    throw new Error("The browser Better Auth cookie is invalid.");
  }
  await context.addCookies([{ name, value, url: state.dashboardUrl }]);
  const page = await context.newPage();
  await page.goto(new URL(path, state.dashboardUrl).href);
  await page.waitForURL(new URL(path, state.dashboardUrl).href);
  return page;
}

async function waitForFirstSessionRow(page: Page): Promise<Locator> {
  const rows = page.getByRole("listbox", { name: "Sessions" }).getByRole("option");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  return rows.first();
}

async function waitForFirstLiveRow(page: Page, timeoutMs: number): Promise<Locator> {
  const rows = liveRows(page);
  await expect(rows.first()).toBeVisible({ timeout: timeoutMs });
  return rows.first();
}

function liveRows(page: Page): Locator {
  return page.locator("section").filter({ hasText: "Live now" }).getByRole("link");
}

async function readFirstLiveElapsed(page: Page): Promise<string> {
  return liveRows(page).first().locator("span").last().innerText();
}

async function waitForReplayFrameWithText(
  page: Page,
  text: string | readonly string[],
  timeoutMs: number,
): Promise<Frame> {
  const candidates = typeof text === "string" ? [text] : text;
  return poll(async () => {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) {
        continue;
      }

      try {
        const bodyText = await frame.evaluate(() => document.body?.innerText ?? "");
        if (candidates.some((candidate) => bodyText.includes(candidate))) {
          return frame;
        }
      } catch {
        /* frame is still loading or was replaced */
      }
    }

    return null;
  }, timeoutMs);
}

async function replayFitsInsideStage(page: Page): Promise<boolean> {
  const geometry = await readReplayGeometry(page);
  if (geometry === null) {
    return false;
  }

  const tolerance = 2;
  return (
    geometry.iframeLeft >= geometry.stageLeft - tolerance &&
    geometry.iframeRight <= geometry.stageRight + tolerance &&
    geometry.iframeTop >= geometry.stageTop - tolerance &&
    geometry.iframeBottom <= geometry.stageBottom + tolerance &&
    geometry.scale < 1
  );
}

async function readReplayGeometry(page: Page): Promise<ReplayGeometry | null> {
  return page.evaluate(() => {
    const stage = document.querySelector('[data-testid="replay-stage"]');
    const wrapper = stage?.querySelector(".replayer-wrapper");
    const iframe = stage?.querySelector("iframe");

    if (
      !(stage instanceof HTMLElement) ||
      !(wrapper instanceof HTMLElement) ||
      !(iframe instanceof HTMLIFrameElement)
    ) {
      return null;
    }

    const stageBox = stage.getBoundingClientRect();
    const iframeBox = iframe.getBoundingClientRect();
    const transform = window.getComputedStyle(wrapper).transform;
    const scale = transform === "none" ? 1 : new DOMMatrixReadOnly(transform).a;
    const leftGap = iframeBox.left - stageBox.left;
    const rightGap = stageBox.right - iframeBox.right;

    return {
      iframeLeft: iframeBox.left,
      iframeRight: iframeBox.right,
      iframeTop: iframeBox.top,
      iframeBottom: iframeBox.bottom,
      stageLeft: stageBox.left,
      stageRight: stageBox.right,
      stageTop: stageBox.top,
      stageBottom: stageBox.bottom,
      leftGap,
      rightGap,
      scale,
    };
  });
}

function startSmallLiveActions(page: Page): () => void {
  let stopped = false;
  let chain = Promise.resolve();
  const interval = setInterval(() => {
    chain = chain
      .then(async () => {
        if (stopped || page.isClosed()) {
          return;
        }

        await page.getByRole("button", { name: /^(Show|Hide) stock panel$/ }).click({
          timeout: 750,
        });
        await page.getByRole("button", { name: "Save settings" }).click({ timeout: 750 });
      })
      .catch(() => undefined);
  }, 800);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== null) {
      return value;
    }
    await delay(250);
  }

  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function formatErrorCount(count: number): string {
  return `${count} ${count === 1 ? "error" : "errors"}`;
}

function formatLocation(country: string | null, city: string | null): string {
  const cleanCity = city?.trim() ?? "";
  if (cleanCity.length > 0) return cleanCity;

  const cleanCountry = country?.trim() ?? "";
  return cleanCountry.length > 0 ? cleanCountry.toUpperCase() : "Unknown";
}

function entryPath(value: string | null): string {
  if (value === null || value.length === 0) return "/";

  try {
    const url = new URL(value, "https://demo.invalid");
    return `${url.pathname}${url.search}`;
  } catch {
    return value.startsWith("/") ? value : `/${value}`;
  }
}

function readNumber(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function requirePage(page: Page | undefined): Page {
  if (page === undefined) {
    throw new Error("test page is not ready");
  }

  return page;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
