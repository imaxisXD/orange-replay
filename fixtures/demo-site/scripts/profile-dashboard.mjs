import { access, writeFile } from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright";

const defaultUrl = "http://localhost:8787/demo/overview";
const targetUrl = process.env["DASHBOARD_PERF_URL"] ?? defaultUrl;
const workerUrl = process.env["DASHBOARD_PERF_WORKER_URL"] ?? new URL(targetUrl).origin;
const runCount = readPositiveInteger("DASHBOARD_PERF_RUNS", 3);
const shouldAssert =
  process.argv.includes("--assert") || process.env["DASHBOARD_PERF_ASSERT"] === "1";
const outputPath = process.env["DASHBOARD_PERF_OUTPUT"];
const storageStatePath = process.env["DASHBOARD_PERF_STORAGE_STATE"];
const headless = process.env["DASHBOARD_PERF_HEADFUL"] !== "1";

const budgets = {
  lcpMs: readPositiveNumber("DASHBOARD_PERF_MAX_LCP_MS", 500),
  overviewInteractionMs: readPositiveNumber("DASHBOARD_PERF_MAX_OVERVIEW_INTERACTION_MS", 100),
  firstRouteMs: readPositiveNumber("DASHBOARD_PERF_MAX_FIRST_ROUTE_MS", 300),
  warmRouteMs: readPositiveNumber("DASHBOARD_PERF_MAX_WARM_ROUTE_MS", 120),
  loadRequestCount: readPositiveInteger("DASHBOARD_PERF_MAX_LOAD_REQUESTS", 200),
  routeRequestCount: readPositiveInteger("DASHBOARD_PERF_MAX_ROUTE_REQUESTS", 110),
  scrollFrameP95Ms: readPositiveNumber("DASHBOARD_PERF_MAX_SCROLL_P95_MS", 24),
  longestTaskMs: readPositiveNumber("DASHBOARD_PERF_MAX_LONG_TASK_MS", 100),
};

await checkServer(targetUrl);
if (storageStatePath !== undefined) await access(storageStatePath);

const executablePath = await findBrowserExecutable();
const authCookie =
  storageStatePath === undefined ? await createLocalTestSession(targetUrl, workerUrl) : undefined;
const results = [];

for (let run = 1; run <= runCount; run += 1) {
  const browser = await chromium.launch({
    headless,
    ...(executablePath === undefined ? {} : { executablePath }),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(storageStatePath === undefined ? {} : { storageState: storageStatePath }),
  });

  if (authCookie !== undefined) {
    await context.addCookies([cookieForUrl(authCookie, targetUrl)]);
  }

  const page = await context.newPage();
  const devtools = await context.newCDPSession(page);
  await devtools.send("Network.enable");
  await devtools.send("Network.setCacheDisabled", { cacheDisabled: true });
  await devtools.send("Network.setBypassServiceWorker", { bypass: true });
  await devtools.send("Performance.enable");

  let transferredBytes = 0;
  devtools.on("Network.loadingFinished", (event) => {
    transferredBytes += event.encodedDataLength;
  });

  const requests = [];
  const failedRequests = [];
  const consoleErrors = [];

  page.on("request", (request) => {
    requests.push({ resourceType: request.resourceType(), url: request.url() });
  });
  page.on("requestfailed", (request) => {
    failedRequests.push({
      error: request.failure()?.errorText ?? "Request failed",
      resourceType: request.resourceType(),
      url: request.url(),
    });
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.addInitScript(() => {
    globalThis.__orangeReplayPerformance = {
      cls: 0,
      interactions: [],
      lcp: 0,
      longTasks: [],
    };

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        globalThis.__orangeReplayPerformance.lcp = Math.max(
          globalThis.__orangeReplayPerformance.lcp,
          entry.startTime,
        );
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) globalThis.__orangeReplayPerformance.cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        globalThis.__orangeReplayPerformance.longTasks.push(entry.duration);
      }
    }).observe({ type: "longtask", buffered: true });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.interactionId === 0) continue;
        globalThis.__orangeReplayPerformance.interactions.push({
          duration: entry.duration,
          inputDelay: entry.processingStart - entry.startTime,
          name: entry.name,
          presentationDelay: Math.max(0, entry.duration - (entry.processingEnd - entry.startTime)),
          processingDuration: entry.processingEnd - entry.processingStart,
          target:
            entry.target?.getAttribute?.("aria-label") ?? entry.target?.textContent?.trim() ?? "",
        });
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  });

  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (new URL(page.url()).pathname === "/login") {
    throw new Error(
      "The dashboard redirected to sign in. Use local test routes or set DASHBOARD_PERF_STORAGE_STATE to a signed-in Playwright storage-state file.",
    );
  }
  await page.getByRole("heading", { name: /^Overview/ }).waitFor();
  await waitForNetwork(page);

  const loadRequestCount = requests.length;
  const loadTransferredBytes = transferredBytes;
  const loadFailedRequestCount = failedRequests.length;
  const loadAbortedApiRequests = countAbortedApiRequests(failedRequests);
  const loadMetrics = await readLoadMetrics(page);
  const overviewInteraction = await measureOverviewInteractions(page);

  const firstRouteStartedWith = requests.length;
  const firstRouteFailedWith = failedRequests.length;
  const firstRouteMs = await measureRoute(page, "Sessions");
  await waitForNetwork(page);
  const firstRouteReadyMs = await readRouteReadyTime(page);
  const firstRouteRequestCount = requests.length - firstRouteStartedWith;
  const firstRouteFailedRequestCount = failedRequests.length - firstRouteFailedWith;
  const firstRouteAbortedApiRequests = countAbortedApiRequests(
    failedRequests.slice(firstRouteFailedWith),
  );

  await measureRoute(page, "Overview");
  await waitForNetwork(page);
  const warmRouteMs = await measureRoute(page, "Sessions");
  await waitForNetwork(page);
  await measureRoute(page, "Overview");
  await waitForNetwork(page);

  const scroll = await measureScrollFrames(page);
  const browserMetrics = await readBrowserMetrics(devtools);
  const longTasks = await page.evaluate(
    () => globalThis.__orangeReplayPerformance?.longTasks ?? [],
  );

  results.push({
    run,
    load: {
      cls: round(loadMetrics.cls, 3),
      domContentLoadedMs: round(loadMetrics.domContentLoadedMs),
      fcpMs: round(loadMetrics.fcpMs),
      lcpMs: round(loadMetrics.lcpMs),
      failedRequestCount: loadFailedRequestCount,
      requestCount: loadRequestCount,
      scriptRequestCount: requests.slice(0, loadRequestCount).filter(isScriptRequest).length,
      transferredKiB: round(loadTransferredBytes / 1024),
    },
    overviewInteraction,
    firstRoute: {
      failedRequestCount: firstRouteFailedRequestCount,
      readyMs: round(firstRouteReadyMs),
      requestCount: firstRouteRequestCount,
      scriptRequestCount: requests
        .slice(firstRouteStartedWith, firstRouteStartedWith + firstRouteRequestCount)
        .filter(isScriptRequest).length,
      shellMs: round(firstRouteMs),
    },
    warmRouteMs: round(warmRouteMs),
    scroll,
    runtime: {
      consoleErrorCount: consoleErrors.length,
      heapMiB: round(browserMetrics.JSHeapUsedSize / 1024 / 1024),
      layoutCount: browserMetrics.LayoutCount,
      longestTaskMs: round(Math.max(0, ...longTasks)),
      longTaskCount: longTasks.length,
      nodeCount: browserMetrics.Nodes,
      styleRecalcCount: browserMetrics.RecalcStyleCount,
      transferredKiB: round(transferredBytes / 1024),
    },
    diagnostics: {
      firstRouteAbortedApiRequests,
      loadAbortedApiRequests,
      totalAbortedApiRequests: countAbortedApiRequests(failedRequests),
      apiRequestCount: requests.filter((request) => request.url.includes("/api/")).length,
    },
  });

  await browser.close();
}

const summary = summarize(results);
const report = {
  auth:
    authCookie === undefined
      ? storageStatePath === undefined
        ? "none"
        : "storage state"
      : "local test session",
  browser: executablePath ?? "Playwright Chromium",
  budgets,
  cache: "disabled for each run",
  runs: results,
  summary,
  url: targetUrl,
};

console.log(JSON.stringify(report, null, 2));

if (outputPath !== undefined) {
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

const failures = budgetFailures(summary, budgets);
if (failures.length > 0) {
  console.error("\nPerformance budget warnings:");
  for (const failure of failures) console.error(`- ${failure}`);
  if (shouldAssert) process.exitCode = 1;
}

async function checkServer(url) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
    if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(
      `The existing dashboard server is not reachable at ${url}. Start or reuse it before running this profile. ${error instanceof Error ? error.message : ""}`,
    );
  }
}

async function createLocalTestSession(url, localWorkerUrl) {
  const match = new URL(url).pathname.match(/^\/projects\/([^/]+)\/overview\/?$/);
  if (match === null) return undefined;

  const response = await fetch(`${localWorkerUrl}/__test/api/hosted/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectIds: [decodeURIComponent(match[1])] }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);

  if (response === undefined || !response.ok) return undefined;
  const body = await response.json();
  return typeof body.cookie === "string" ? body.cookie : undefined;
}

function cookieForUrl(cookieHeader, url) {
  const [cookie, ...attributes] = cookieHeader.split(";").map((part) => part.trim());
  const separator = cookie.indexOf("=");
  if (separator === -1) throw new Error("The local test session cookie is invalid.");

  const attributeSet = new Set(attributes.map((attribute) => attribute.toLowerCase()));
  return {
    name: cookie.slice(0, separator),
    value: cookie.slice(separator + 1),
    url: new URL(url).origin,
    httpOnly: attributeSet.has("httponly"),
    secure: attributeSet.has("secure"),
    sameSite: attributes.some((attribute) => attribute.toLowerCase() === "samesite=strict")
      ? "Strict"
      : attributes.some((attribute) => attribute.toLowerCase() === "samesite=none")
        ? "None"
        : "Lax",
  };
}

async function findBrowserExecutable() {
  if (process.env["DASHBOARD_PERF_EXECUTABLE"] !== undefined) {
    await access(process.env["DASHBOARD_PERF_EXECUTABLE"]);
    return process.env["DASHBOARD_PERF_EXECUTABLE"];
  }

  const bravePath = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
  try {
    await access(bravePath);
    return bravePath;
  } catch {
    return undefined;
  }
}

async function waitForNetwork(page) {
  await page.waitForLoadState("networkidle", { timeout: 10_000 });
}

async function readLoadMetrics(page) {
  return page.evaluate(async () => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const lcpMs = await new Promise((resolve) => {
      let latestLcp = globalThis.__orangeReplayPerformance?.lcp ?? 0;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) latestLcp = Math.max(latestLcp, entry.startTime);
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          observer.disconnect();
          resolve(latestLcp);
        }),
      );
    });
    const paints = performance.getEntriesByType("paint");
    const fcp = paints.find((entry) => entry.name === "first-contentful-paint");
    return {
      cls: globalThis.__orangeReplayPerformance?.cls ?? 0,
      domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? 0,
      fcpMs: fcp?.startTime ?? 0,
      lcpMs,
    };
  });
}

async function measureOverviewInteractions(page) {
  await page.evaluate(() => {
    globalThis.__orangeReplayPerformance.interactions = [];
  });

  await clickAndPaint(page, "tab", "Regions");
  await clickAndPaint(page, "tab", "Countries");
  await clickAndPaint(page, "tab", "Browser");
  await clickAndPaint(page, "tab", "OS");
  await clickAndPaint(page, "tab", "Device");
  await clickAndPaint(page, "combobox", "Date range");
  await page.keyboard.press("Escape");
  await waitForTwoFrames(page);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));

  const interactions = await page.evaluate(
    () => globalThis.__orangeReplayPerformance?.interactions ?? [],
  );
  const slowest = interactions.slice().sort((left, right) => right.duration - left.duration)[0];

  return {
    eventCount: interactions.length,
    inputDelayMs: round(slowest?.inputDelay ?? 0),
    processingMs: round(slowest?.processingDuration ?? 0),
    presentationDelayMs: round(slowest?.presentationDelay ?? 0),
    slowestEvent: slowest?.name ?? "none",
    slowestTarget: slowest?.target ?? "",
    totalMs: round(slowest?.duration ?? 0),
  };
}

async function clickAndPaint(page, role, name) {
  await page.getByRole(role, { name }).click();
  await waitForTwoFrames(page);
}

async function waitForTwoFrames(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function measureRoute(page, linkName) {
  return page.evaluate(async (name) => {
    const target = [...document.querySelectorAll("a")].find(
      (link) => link.textContent?.trim() === name,
    );
    if (target === undefined) throw new Error(`${name} link was not found.`);

    const targetPath = new URL(target.href).pathname;
    const startedAt = performance.now();
    globalThis.__orangeReplayRouteStartedAt = startedAt;
    target.click();

    while (location.pathname !== targetPath) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    while (
      ![...document.querySelectorAll("h1")].some((heading) =>
        heading.textContent?.trim().startsWith(name),
      )
    ) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - startedAt;
  }, linkName);
}

async function readRouteReadyTime(page) {
  return page.evaluate(() => performance.now() - globalThis.__orangeReplayRouteStartedAt);
}

async function measureScrollFrames(page) {
  return page.evaluate(async () => {
    const viewports = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')].filter(
      (element) => element.scrollHeight > element.clientHeight + 1,
    );
    const viewport = viewports.sort((left, right) => right.clientHeight - left.clientHeight)[0];
    if (viewport === undefined) return { droppedFrameCount: 0, frameP95Ms: 0, sampledFrames: 0 };

    viewport.scrollTop = 0;
    const frameTimes = [];
    const duration = 800;
    const distance = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const startedAt = performance.now();
    let previousFrame = startedAt;

    await new Promise((resolve) => {
      function frame(now) {
        frameTimes.push(now - previousFrame);
        previousFrame = now;
        viewport.scrollTop = distance * Math.min(1, (now - startedAt) / duration);
        if (now - startedAt < duration) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });

    viewport.scrollTop = 0;
    const sorted = frameTimes.slice().sort((left, right) => left - right);
    return {
      droppedFrameCount: frameTimes.filter((durationMs) => durationMs > 25).length,
      frameP95Ms: Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 10) / 10,
      sampledFrames: frameTimes.length,
    };
  });
}

async function readBrowserMetrics(devtools) {
  const response = await devtools.send("Performance.getMetrics");
  return Object.fromEntries(response.metrics.map((metric) => [metric.name, metric.value]));
}

function summarize(runResults) {
  return {
    lcpMs: median(runResults.map((result) => result.load.lcpMs)),
    overviewInteractionMs: median(runResults.map((result) => result.overviewInteraction.totalMs)),
    firstRouteMedianMs: median(runResults.map((result) => result.firstRoute.shellMs)),
    firstRouteMaxMs: Math.max(...runResults.map((result) => result.firstRoute.shellMs)),
    firstRouteReadyMs: median(runResults.map((result) => result.firstRoute.readyMs)),
    warmRouteMs: median(runResults.map((result) => result.warmRouteMs)),
    loadRequestCount: median(runResults.map((result) => result.load.requestCount)),
    loadScriptRequestCount: median(runResults.map((result) => result.load.scriptRequestCount)),
    loadTransferredKiB: median(runResults.map((result) => result.load.transferredKiB)),
    routeRequestCount: median(runResults.map((result) => result.firstRoute.requestCount)),
    routeScriptRequestCount: median(
      runResults.map((result) => result.firstRoute.scriptRequestCount),
    ),
    scrollFrameP95Ms: median(runResults.map((result) => result.scroll.frameP95Ms)),
    longestTaskMs: Math.max(...runResults.map((result) => result.runtime.longestTaskMs)),
    loadAbortedApiRequests: median(
      runResults.map((result) => result.diagnostics.loadAbortedApiRequests),
    ),
    firstRouteAbortedApiRequests: median(
      runResults.map((result) => result.diagnostics.firstRouteAbortedApiRequests),
    ),
  };
}

function budgetFailures(summaryResult, limits) {
  return [
    checkBudget("LCP", summaryResult.lcpMs, limits.lcpMs, "ms"),
    checkBudget(
      "Overview interaction",
      summaryResult.overviewInteractionMs,
      limits.overviewInteractionMs,
      "ms",
    ),
    checkBudget(
      "slowest first route shell",
      summaryResult.firstRouteMaxMs,
      limits.firstRouteMs,
      "ms",
    ),
    checkBudget("warm route shell", summaryResult.warmRouteMs, limits.warmRouteMs, "ms"),
    checkBudget("overview requests", summaryResult.loadRequestCount, limits.loadRequestCount, ""),
    checkBudget(
      "first route requests",
      summaryResult.routeRequestCount,
      limits.routeRequestCount,
      "",
    ),
    checkBudget("scroll frame p95", summaryResult.scrollFrameP95Ms, limits.scrollFrameP95Ms, "ms"),
    checkBudget("longest task", summaryResult.longestTaskMs, limits.longestTaskMs, "ms"),
  ].filter(Boolean);
}

function checkBudget(label, actual, expected, unit) {
  return actual > expected ? `${label} was ${actual}${unit}; budget is ${expected}${unit}.` : "";
}

function isScriptRequest(request) {
  return request.resourceType === "script";
}

function countAbortedApiRequests(requests) {
  return requests.filter(
    (request) => request.url.includes("/api/") && request.error.includes("ABORTED"),
  ).length;
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round((sorted[middle - 1] + sorted[middle]) / 2)
    : round(sorted[middle]);
}

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function readPositiveInteger(name, fallback) {
  return Math.round(readPositiveNumber(name, fallback));
}

function readPositiveNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}
