import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { decodeIngestBody, FLAG_UNCOMPRESSED } from "@orange-replay/shared";

const sdkBundle = fileURLToPath(
  new URL("../../../packages/sdk/dist/orange-replay.iife.js", import.meta.url),
);
const writeKey = `or_live_${"b".repeat(32)}`;
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const runFile = promisify(execFile);
const sdkBufferCapBytes = 4 * 1024 * 1024;

// Playwright's retained trace snapshots the whole DOM around each action. That
// would add a second recorder to this benchmark and hide the SDK's own cost.
test.use({ trace: "off" });

interface CapturedBatch {
  body: Uint8Array;
  flags: number;
}

interface SnapshotPerformanceMetrics {
  maxFrameGapMs: number;
  largestFrameGaps: Array<{ at: number; gap: number }>;
  longestLongTaskMs: number;
  longAnimationFrames: unknown[];
  maxBlockingDurationMs: number;
  timeOrigin: number;
}

test.beforeAll(async () => {
  await runFile(process.execPath, [
    fileURLToPath(new URL("../../../packages/sdk/scripts/build-browser.mjs", import.meta.url)),
  ]);
});

test("keeps legacy loader auto-start working", async ({ page }) => {
  const batches: CapturedBatch[] = [];
  await installTestRoutes(page, batches);
  await page.goto("https://snapshot.test/");
  await page.evaluate(
    ({ key }) => {
      (window as unknown as { __orInit: Record<string, unknown> }).__orInit = {
        key,
        ingestUrl: "https://snapshot.test",
        transport: "worker",
        flushMs: 50,
      };
    },
    { key: writeKey },
  );

  await page.addScriptTag({ path: sdkBundle });

  await expect.poll(() => batches.length, { timeout: 5_000 }).toBeGreaterThan(0);
  expect(
    await page.evaluate(
      () => typeof (window as unknown as { OrangeReplay?: unknown }).OrangeReplay,
    ),
  ).toBe("object");
  expect(
    await page.evaluate(() => {
      const loaderWindow = window as unknown as {
        __orInit: Record<string, unknown>;
        OrangeReplay: {
          init(options: Record<string, unknown>): {
            stop: unknown;
            addCustomEvent: unknown;
            getSessionUrl: unknown;
          };
        };
      };
      const handle = loaderWindow.OrangeReplay.init(loaderWindow.__orInit);
      return [typeof handle.stop, typeof handle.addCustomEvent, typeof handle.getSessionUrl];
    }),
  ).toEqual(["function", "function", "function"]);
});

test("uses the first valid queued init when the direct loader config is invalid", async ({
  page,
}) => {
  const batches: CapturedBatch[] = [];
  await installTestRoutes(page, batches);
  await page.goto("https://snapshot.test/");
  await page.evaluate(
    ({ key }) => {
      const loaderWindow = window as unknown as { __orInit: unknown; __orq: unknown[] };
      loaderWindow.__orInit = null;
      loaderWindow.__orq = [
        { k: "init", o: null },
        {
          k: "init",
          o: {
            key,
            ingestUrl: "https://snapshot.test",
            transport: "worker",
            flushMs: 50,
          },
        },
      ];
    },
    { key: writeKey },
  );

  await page.addScriptTag({ path: sdkBundle });

  await expect.poll(() => batches.length, { timeout: 5_000 }).toBeGreaterThan(0);
});

for (const { elementCount, insideIframe, cpuSlowdown } of [
  { elementCount: 10_000, insideIframe: false, cpuSlowdown: 1 },
  { elementCount: 100_000, insideIframe: true, cpuSlowdown: 4 },
  { elementCount: 100_000, insideIframe: false, cpuSlowdown: 4 },
]) {
  const location = insideIframe ? " same-origin iframe" : " page";
  const throttle = cpuSlowdown > 1 ? ` at ${cpuSlowdown}x CPU slowdown` : "";
  test(`keeps a ${elementCount.toLocaleString("en-US")}-element${location} responsive${throttle}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    if (cpuSlowdown > 1) {
      const devtools = await page.context().newCDPSession(page);
      await devtools.send("Emulation.setCPUThrottlingRate", { rate: cpuSlowdown });
    }
    const batches: CapturedBatch[] = [];
    await installTestRoutes(page, batches);
    await page.goto("https://snapshot.test/");
    await buildLargePage(page, elementCount, insideIframe);
    // Let DOM-construction garbage collection settle before attributing frame
    // gaps to the recorder.
    await page.waitForTimeout(1_000);
    await resetSnapshotPerformanceMetrics(page);
    await startPerformanceReplay(page);

    await expect.poll(() => batches.length, { timeout: 60_000 }).toBeGreaterThan(0);
    await page.evaluate(() => {
      const middleRow =
        document.querySelector("[data-snapshot-row='middle']") ??
        document
          .querySelector("iframe")
          ?.contentDocument?.querySelector("[data-snapshot-row='middle']");
      if (middleRow === null || middleRow === undefined) throw new Error("Middle row is missing.");
      middleRow.textContent = "after-snapshot";
      const input = document.querySelector("input");
      if (input === null) throw new Error("Private input is missing.");
      input.value = "private-large-dom-live-value";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(2_500);
    await stopPerformanceReplay(page);

    const replay = await readReplayBatches(batches);
    const metrics = await readSnapshotPerformanceMetrics(page);

    expect(replay.fullSnapshotCount).toBe(1);
    expect(replay.text).toContain("snapshot-first");
    expect(replay.text).toContain("snapshot-middle");
    expect(replay.text).toContain("snapshot-last");
    expect(replay.text).toContain("after-snapshot");
    expect(replay.text).not.toContain("private-large-dom-value");
    expect(replay.text).not.toContain("private-large-dom-live-value");
    expect(replay.text).not.toContain("private-stale-input-attribute");
    expect(replay.text).not.toContain("private-checkbox-value");
    expect(replay.text).not.toContain("private-radio-value");
    expect(replay.text).not.toContain("private-option-value");
    expect(replay.text).toContain('"rr_type":"ImageBitmap"');
    expectResponsiveSnapshot(metrics, cpuSlowdown);
  });
}

test("sequences a large page and two oversized same-origin iframe snapshots", async ({ page }) => {
  test.setTimeout(240_000);
  const devtools = await page.context().newCDPSession(page);
  await devtools.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  const batches: CapturedBatch[] = [];
  let observedIframeAttachments = 0;
  let observationError: unknown;
  let observation = Promise.resolve();
  await installTestRoutes(page, batches, (batch) => {
    observation = observation
      .then(async () => {
        const events = await readCapturedBatch(batch);
        observedIframeAttachments += events.filter(isIframeAttachment).length;
      })
      .catch((error: unknown) => {
        observationError = error;
      });
  });
  await page.goto("https://snapshot.test/");
  await buildLargePage(page, 20_000, false);
  await appendOversizedIframeDocuments(page, 100_000);
  await page.waitForTimeout(1_000);
  await resetSnapshotPerformanceMetrics(page);

  await startPerformanceReplay(page);
  await expect
    .poll(
      () => {
        if (observationError !== undefined) throw observationError;
        return observedIframeAttachments;
      },
      { timeout: 180_000 },
    )
    .toBe(2);
  await page.waitForTimeout(1_000);
  await stopPerformanceReplay(page);
  await observation;

  const replay = await readReplayBatches(batches);
  const metrics = await readSnapshotPerformanceMetrics(page);
  expect(replay.fullSnapshotCount).toBe(1);
  expect(replay.iframeAttachmentCount).toBe(2);
  expect(replay.iframeAttachmentJsonBytes).toHaveLength(2);
  for (const bytes of replay.iframeAttachmentJsonBytes) {
    expect(bytes).toBeGreaterThan(sdkBufferCapBytes);
  }
  for (const marker of [
    "snapshot-first",
    "snapshot-middle",
    "snapshot-last",
    "frame-one-snapshot-first",
    "frame-one-snapshot-middle",
    "frame-one-snapshot-last",
    "frame-two-snapshot-first",
    "frame-two-snapshot-middle",
    "frame-two-snapshot-last",
  ]) {
    expect(replay.text).toContain(marker);
  }
  for (const secret of [
    "private-large-dom-value",
    "private-stale-input-attribute",
    "private-checkbox-value",
    "private-radio-value",
    "private-option-value",
    "private-frame-one-input",
    "private-frame-one-attribute",
    "private-frame-two-input",
    "private-frame-two-attribute",
  ]) {
    expect(replay.text).not.toContain(secret);
  }
  // This fixture retains 220k nodes at 4x slowdown, so Chromium's GC pauses are
  // larger than the single-tree case. Keep them below a short interaction beat.
  expectResponsiveSnapshot(metrics, 4, {
    longestLongTaskMs: 130,
    maxBlockingDurationMs: 80,
    maxFrameGapMs: 130,
  });
});

async function installTestRoutes(
  page: Page,
  batches: CapturedBatch[],
  onBatch?: (batch: CapturedBatch) => void,
): Promise<void> {
  await page.route("https://snapshot.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/v1/config") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          sampleRate: 1,
          maskPolicyVersion: 1,
          maskRules: [],
          capture: { heatmaps: false, console: false, network: false, canvas: true },
          version: 1,
        }),
      });
      return;
    }
    if (url.pathname === "/v1/ingest") {
      const body = request.postDataBuffer();
      if (body !== null) {
        const batch = {
          body: new Uint8Array(body),
          flags: Number(request.headers()["x-or-flags"] ?? -1),
        };
        batches.push(batch);
        onBatch?.(batch);
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, live: false, flushMs: 1_000 }),
      });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><head><title>Snapshot performance</title></head><body></body></html>",
    });
  });
}

async function buildLargePage(
  page: Page,
  elementCount: number,
  insideIframe: boolean,
): Promise<void> {
  await page.evaluate(
    async ({ count, insideIframe }) => {
      let treeDocument = document;
      if (insideIframe) {
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        treeDocument = iframe.contentDocument!;
        treeDocument.open();
        treeDocument.write("<!doctype html><html><body></body></html>");
        treeDocument.close();
      }

      const largeTree = treeDocument.createElement("div");
      // Keep layout/paint cost out of this SDK benchmark. The recorder still
      // walks every descendant while the visible canvas and CSS marker animate.
      largeTree.style.display = "none";
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < count; index += 1) {
        const row = treeDocument.createElement("div");
        row.dataset.snapshotRow =
          index === 0 ? "first" : index === Math.floor(count / 2) ? "middle" : "row";
        row.textContent =
          index === 0
            ? "snapshot-first"
            : index === Math.floor(count / 2)
              ? "snapshot-middle"
              : index === count - 1
                ? "snapshot-last"
                : `row-${index}`;
        fragment.appendChild(row);
      }
      largeTree.appendChild(fragment);
      treeDocument.body.appendChild(largeTree);

      const input = document.createElement("input");
      input.value = "private-large-dom-value";
      document.body.appendChild(input);
      const staleInput = document.createElement("input");
      staleInput.setAttribute("value", "private-stale-input-attribute");
      staleInput.value = "";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = "private-checkbox-value";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.value = "private-radio-value";
      const select = document.createElement("select");
      const option = document.createElement("option");
      option.value = "private-option-value";
      option.textContent = "Visible option";
      select.appendChild(option);
      document.body.append(staleInput, checkbox, radio, select);
      const image = document.createElement("img");
      image.src =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      document.body.appendChild(image);
      await image.decode();

      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      document.body.appendChild(canvas);
      const context = canvas.getContext("2d")!;
      const animatedMarker = document.createElement("div");
      animatedMarker.style.cssText =
        "position:fixed;width:8px;height:8px;background:#ffb000;animation:pulse 400ms ease-in-out infinite alternate";
      document.body.appendChild(animatedMarker);
      const style = document.createElement("style");
      style.textContent =
        "@keyframes pulse{from{transform:translateX(0)}to{transform:translateX(40px)}}";
      document.head.appendChild(style);

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

      const performanceState = {
        frameGaps: [] as Array<{ at: number; gap: number }>,
        longTasks: [] as number[],
        longAnimationFrames: [] as unknown[],
      };
      (
        window as unknown as { __snapshotPerformance: typeof performanceState }
      ).__snapshotPerformance = performanceState;
      let previousFrame = performance.now();
      const animate = (time: number) => {
        performanceState.frameGaps.push({ at: time, gap: time - previousFrame });
        previousFrame = time;
        context.fillStyle = `hsl(${Math.floor(time / 10) % 360} 90% 55%)`;
        context.fillRect(0, 0, canvas.width, canvas.height);
        requestAnimationFrame(animate);
      };
      requestAnimationFrame(animate);
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) performanceState.longTasks.push(entry.duration);
        }).observe({ entryTypes: ["longtask"] });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            performanceState.longAnimationFrames.push(entry.toJSON());
          }
        }).observe({ type: "long-animation-frame", buffered: true });
      } catch {
        // Chromium supports Long Tasks; frame gaps remain the fallback signal.
      }
    },
    { count: elementCount, insideIframe },
  );
}

async function appendOversizedIframeDocuments(page: Page, elementCount: number): Promise<void> {
  await page.evaluate(
    async ({ count }) => {
      const appendTree = (treeDocument: Document, markerPrefix: string) => {
        const largeTree = treeDocument.createElement("div");
        largeTree.style.display = "none";
        const fragment = treeDocument.createDocumentFragment();
        for (let index = 0; index < count; index += 1) {
          const row = treeDocument.createElement("div");
          const position =
            index === 0 ? "first" : index === Math.floor(count / 2) ? "middle" : "row";
          row.dataset.snapshotRow = `${markerPrefix}-${position}`;
          row.textContent =
            index === 0
              ? `${markerPrefix}-snapshot-first`
              : index === Math.floor(count / 2)
                ? `${markerPrefix}-snapshot-middle`
                : index === count - 1
                  ? `${markerPrefix}-snapshot-last`
                  : `${markerPrefix}-row-${index}`;
          fragment.appendChild(row);
        }
        largeTree.appendChild(fragment);
        treeDocument.body.appendChild(largeTree);

        const input = treeDocument.createElement("input");
        input.setAttribute("value", `private-${markerPrefix}-attribute`);
        input.value = `private-${markerPrefix}-input`;
        treeDocument.body.appendChild(input);
      };

      for (const markerPrefix of ["frame-one", "frame-two"]) {
        const iframe = document.createElement("iframe");
        iframe.dataset.snapshotFrame = markerPrefix;
        iframe.style.display = "none";
        document.body.appendChild(iframe);
        const frameDocument = iframe.contentDocument;
        if (frameDocument === null) throw new Error(`${markerPrefix} document is missing.`);
        frameDocument.open();
        frameDocument.write("<!doctype html><html><body></body></html>");
        frameDocument.close();
        appendTree(frameDocument, markerPrefix);
      }

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    },
    { count: elementCount },
  );
}

async function startPerformanceReplay(page: Page): Promise<void> {
  await page.addScriptTag({ path: sdkBundle });
  await page.evaluate(
    ({ key }) => {
      const orangeReplay = (
        window as unknown as {
          OrangeReplay: {
            init(options: Record<string, unknown>): { stop(): Promise<void> };
          };
        }
      ).OrangeReplay;
      (
        window as unknown as { __performanceReplay: { stop(): Promise<void> } }
      ).__performanceReplay = orangeReplay.init({
        key,
        ingestUrl: "https://snapshot.test",
        transport: "worker",
      });
    },
    { key: writeKey },
  );
}

async function stopPerformanceReplay(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (
      window as unknown as { __performanceReplay: { stop(): Promise<void> } }
    ).__performanceReplay.stop();
  });
}

async function resetSnapshotPerformanceMetrics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (
      window as unknown as {
        __snapshotPerformance: {
          frameGaps: Array<{ at: number; gap: number }>;
          longTasks: number[];
          longAnimationFrames: unknown[];
        };
      }
    ).__snapshotPerformance;
    state.frameGaps = [];
    state.longTasks = [];
    state.longAnimationFrames = [];
  });
}

async function readSnapshotPerformanceMetrics(page: Page): Promise<SnapshotPerformanceMetrics> {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __snapshotPerformance: {
          frameGaps: Array<{ at: number; gap: number }>;
          longTasks: number[];
          longAnimationFrames: unknown[];
        };
      }
    ).__snapshotPerformance;
    return {
      maxFrameGapMs: Math.max(0, ...state.frameGaps.map((entry) => entry.gap)),
      largestFrameGaps: [...state.frameGaps].sort((a, b) => b.gap - a.gap).slice(0, 5),
      longestLongTaskMs: Math.max(0, ...state.longTasks),
      longAnimationFrames: state.longAnimationFrames,
      maxBlockingDurationMs: Math.max(
        0,
        ...state.longAnimationFrames.map((entry) => {
          return Number((entry as { blockingDuration?: unknown }).blockingDuration ?? 0);
        }),
      ),
      timeOrigin: performance.timeOrigin,
    };
  });
}

function expectResponsiveSnapshot(
  metrics: SnapshotPerformanceMetrics,
  cpuSlowdown: number,
  bounds?: {
    longestLongTaskMs: number;
    maxBlockingDurationMs: number;
    maxFrameGapMs: number;
  },
): void {
  const performanceDetails = JSON.stringify(metrics);
  // At 4x slowdown Chromium also stretches stop-the-world GC for retained test
  // DOMs. Keep it below a visible freeze; normal pages stay below a Long Task.
  expect(metrics.longestLongTaskMs, performanceDetails).toBeLessThan(
    bounds?.longestLongTaskMs ?? (cpuSlowdown > 1 ? 100 : 50),
  );
  expect(metrics.maxBlockingDurationMs, performanceDetails).toBeLessThan(
    bounds?.maxBlockingDurationMs ?? (cpuSlowdown > 1 ? 35 : 1),
  );
  expect(metrics.maxFrameGapMs, performanceDetails).toBeLessThan(
    bounds?.maxFrameGapMs ?? (cpuSlowdown > 1 ? 100 : 50),
  );
}

async function readReplayBatches(batches: readonly CapturedBatch[]): Promise<{
  text: string;
  fullSnapshotCount: number;
  iframeAttachmentCount: number;
  iframeAttachmentJsonBytes: number[];
}> {
  const eventLists: unknown[][] = [];
  for (const batch of batches) {
    eventLists.push(await readCapturedBatch(batch));
  }
  const events = eventLists.flat();
  const iframeAttachments = events.filter(isIframeAttachment);
  const text = JSON.stringify(events);
  return {
    text,
    fullSnapshotCount: events.filter((event) => (event as { type?: unknown }).type === 2).length,
    iframeAttachmentCount: iframeAttachments.length,
    iframeAttachmentJsonBytes: iframeAttachments.map(
      (event) => encoder.encode(JSON.stringify(event)).byteLength,
    ),
  };
}

async function readCapturedBatch(batch: CapturedBatch): Promise<unknown[]> {
  const decoded = decodeIngestBody(batch.body);
  const text =
    (batch.flags & FLAG_UNCOMPRESSED) === FLAG_UNCOMPRESSED
      ? decoder.decode(decoded.payload)
      : await gunzipToText(decoded.payload);
  return JSON.parse(text) as unknown[];
}

function isIframeAttachment(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const data = (event as { data?: unknown }).data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { isAttachIframe?: unknown }).isAttachIframe === true
  );
}

async function gunzipToText(payload: Uint8Array): Promise<string> {
  const body = new Response(payload as unknown as BodyInit).body;
  if (body === null) throw new Error("gzip body missing");
  const plain = await new Response(body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return decoder.decode(plain);
}
