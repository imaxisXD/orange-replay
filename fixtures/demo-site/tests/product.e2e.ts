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
  let dashboardContext: BrowserContext | undefined;
  let dashboardPage: Page | undefined;
  let liveContext: BrowserContext | undefined;
  let liveDashboardContext: BrowserContext | undefined;
  let livePage: Page | undefined;
  let liveDashboardPage: Page | undefined;
  let liveSessionId = "";
  let stopLiveActions: (() => void) | undefined;

  try {
    await seedProject(state);

    await test.step("record -> list", async () => {
      const recordContext = await browser.newContext();
      const recordPage = await recordContext.newPage();

      try {
        recordedSessionId = await recordDemoSession(recordPage, state);
      } finally {
        await recordContext.close();
      }

      await waitForFinalize(state, recordedSessionId);
      const indexed = await waitForIndexedSession(state, recordedSessionId);
      recordedSession = indexed.session;

      dashboardContext = await browser.newContext();
      dashboardPage = await openDashboardPage(
        dashboardContext,
        state,
        `/projects/${state.projectId}/sessions`,
      );

      await expect(dashboardPage.locator("body")).not.toContainText(passwordSecret);

      const row = await waitForFirstSessionRow(dashboardPage);
      const entryCell = row.locator("td").first();
      await expect(entryCell.locator("div").first()).toContainText(
        entryPath(recordedSession.entry_url),
      );
      await expect(entryCell.locator("div").nth(1)).toContainText(
        formatPlace(recordedSession.country, recordedSession.city),
      );
      await expect(row.locator("td").nth(1)).toContainText(
        formatErrorCount(recordedSession.errors),
      );
      await expect(row.locator("td").nth(2)).toHaveText(/^\d+:\d{2}$/);

      await row.click();
      await dashboardPage.waitForURL(
        new RegExp(
          `/projects/${escapeRegex(state.projectId)}/sessions/${escapeRegex(recordedSessionId)}$`,
        ),
      );
    });

    await test.step("playback with effects", async () => {
      const page = requirePage(dashboardPage);
      await waitForReplayFrameWithText(page, "Warehouse stock timeline", 20_000);

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

      const errorRow = page
        .locator("aside")
        .getByRole("button")
        .filter({ hasText: /TypeError|run/i })
        .first();
      await expect(errorRow).toBeVisible();

      const timeline = page.getByRole("slider", { name: "Replay timeline" });
      await timeline.click({ position: { x: 1, y: 13 } });
      const before = readNumber(await timeline.getAttribute("aria-valuenow"));
      await errorRow.click();
      await expect
        .poll(async () => readNumber(await timeline.getAttribute("aria-valuenow")))
        .toBeGreaterThan(before);

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
      liveContext = await browser.newContext();
      livePage = await liveContext.newPage();
      await livePage.goto(state.demoUrl);
      await expect(
        livePage.getByRole("heading", { name: "Signal Board starter kit" }),
      ).toBeVisible();
      liveSessionId = await readSessionId(livePage);
      stopLiveActions = startSmallLiveActions(livePage);

      liveDashboardContext = await browser.newContext();
      liveDashboardPage = await openDashboardPage(
        liveDashboardContext,
        state,
        `/projects/${state.projectId}/live`,
      );

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

      await sourcePage.close();
      await waitForFinalize(state, liveSessionId);
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
  apiToken: string;
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

async function recordDemoSession(page: Page, state: ServerState): Promise<string> {
  await page.goto(state.demoUrl);
  await expect(page.getByRole("heading", { name: "Signal Board starter kit" })).toBeVisible();
  const sessionId = await readSessionId(page);

  await page.getByLabel("Workspace name").fill(textSecret);
  await page.getByLabel("Admin password").fill(passwordSecret);
  await page.getByRole("button", { name: "Add product row" }).click();
  await page.getByRole("button", { name: "Show stock panel" }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
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
  return sessionId;
}

async function readSessionId(page: Page): Promise<string> {
  const value = await page.evaluate(() => window.sessionStorage.getItem("or:s"));
  expect(value).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  return value ?? "";
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
  const page = await context.newPage();
  await page.addInitScript((token) => {
    window.localStorage.setItem("or:token", token);
  }, state.apiToken);
  await page.goto(`${state.dashboardUrl}${path}`);
  return page;
}

async function waitForFirstSessionRow(page: Page): Promise<Locator> {
  const rows = page.locator("table").getByRole("link");
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

function formatPlace(country: string | null, city: string | null): string {
  const cleanCity = city?.trim() ?? "";
  if (country === null || country.trim().length === 0) {
    return cleanCity.length > 0 ? cleanCity : "Unknown";
  }

  const code = country.trim().toUpperCase();
  const label = cleanCity.length > 0 ? cleanCity : code;
  return `${flagForCountry(code)} ${label}`;
}

function flagForCountry(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code;
  const first = 0x1f1e6 + code.charCodeAt(0) - 65;
  const second = 0x1f1e6 + code.charCodeAt(1) - 65;
  return String.fromCodePoint(first, second);
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
