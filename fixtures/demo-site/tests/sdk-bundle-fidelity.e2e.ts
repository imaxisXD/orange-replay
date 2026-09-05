import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { decodeIngestBody } from "../../../packages/shared/src/wire.ts";
import type { ReplayEvent } from "../../../packages/player/src/types.ts";
import type { SdkVerificationWindow } from "../src/sdk-bundle-fidelity-proof.ts";

const runFile = promisify(execFile);
const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
let origin = process.env.SDK_VERIFY_ORIGIN;
const bundleDirectory = resolve(repo, process.env.SDK_BUNDLE_DIR ?? "packages/sdk/dist");
const prefix = "/__sdk-reduction-verification";
const helper = `/@fs${repo}/fixtures/demo-site/src/sdk-bundle-fidelity-proof.ts`;
const recorderKey = `or_live_${"b".repeat(32)}`;

test.beforeAll(async () => {
  if (process.env.SDK_BUNDLE_DIR === undefined) {
    await runFile(process.execPath, [resolve(repo, "packages/sdk/scripts/build-browser.mjs")], {
      cwd: repo,
      maxBuffer: 10 * 1024 * 1024,
    });
  }
  if (origin === undefined) {
    const state = JSON.parse(
      await readFile(new URL("../.playwright-state.json", import.meta.url), "utf8"),
    ) as { demoUrl?: unknown };
    if (typeof state.demoUrl !== "string")
      throw new Error("The browser test server URL is missing.");
    origin = state.demoUrl;
  }
});

for (const format of ["iife", "esm"]) {
  for (const { captureCanvas, initialIframe } of [
    { captureCanvas: true, initialIframe: false },
    { captureCanvas: false, initialIframe: false },
    { captureCanvas: false, initialIframe: true },
  ]) {
    test(`${format}: shipped capture replays DOM, privacy, frames, shadow, images; canvas ${captureCanvas ? "on" : "off"}; iframe ${initialIframe ? "before" : "after"} delayed stylesheet`, async ({
      page,
    }, testInfo) => {
      const bundlePath = resolve(
        bundleDirectory,
        format === "iife" ? "orange-replay.iife.js" : "orange-replay.js",
      );
      // Read once: a parallel experiment cannot silently replace the bytes tested.
      const bundle = await readFile(bundlePath);
      const bundleHash = createHash("sha256").update(bundle).digest("hex");
      const batches: Array<{
        body: number[];
        flags: number;
        index: ReturnType<typeof decodeIngestBody>["index"];
        events: ReplayEvent[];
      }> = [];
      const errors: string[] = [];
      let imageRequests = 0;
      let pictureBytes: Buffer | undefined;
      let releaseDelayedStylesheet = () => {};
      const delayedStylesheet = new Promise<void>((resolve) => {
        releaseDelayedStylesheet = resolve;
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route(`${origin}${prefix}/**`, async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith("/v1/config")) {
          await route.fulfill({
            json: {
              sampleRate: 1,
              maskPolicyVersion: 1,
              maskRules: [],
              capture: { heatmaps: false, console: false, network: false, canvas: captureCanvas },
              version: 1,
              domMaskingVersion: 1,
            },
          });
        } else if (path.endsWith("/v1/ingest")) {
          const body = new Uint8Array(request.postDataBuffer()!);
          const flags = Number(request.headers()["x-or-flags"] ?? -1);
          const { index, payload } = decodeIngestBody(body);
          // Normal worker transport must retain its compressed wire contract.
          expect(flags).toBe(0);
          batches.push({
            body: Array.from(body),
            flags,
            index,
            events: JSON.parse(gunzipSync(payload).toString("utf8")),
          });
          await route.fulfill({ json: { ok: true, live: false, flushMs: 1_000 } });
        } else if (path.endsWith("/bundle.js")) {
          await route.fulfill({ contentType: "application/javascript", body: bundle });
        } else if (path.endsWith("/image.png") && pictureBytes) {
          imageRequests += 1;
          await route.fulfill({ contentType: "image/png", body: pictureBytes });
        } else if (path.endsWith("/delayed.css")) {
          await delayedStylesheet;
          await route.fulfill({
            contentType: "text/css",
            body: "#delayed-style-label { color: rgb(11, 22, 33) }",
          });
        } else if (path.endsWith("/added.css")) {
          await route.fulfill({
            contentType: "text/css",
            body: "#added-style-label { color: rgb(44, 55, 66) }",
          });
        } else {
          await route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><html><head><title>SDK shipped bundle verification</title></head><body></body></html>",
          });
        }
      });
      await page.goto(`${origin}${prefix}/capture`);
      await page.evaluate(() => {
        const NativeWorker = Worker;
        (window as unknown as { recorderWorkerSource?: string }).recorderWorkerSource = undefined;
        window.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            if (options?.name === "orange-replay-pipeline")
              (window as unknown as { recorderWorkerSource?: string }).recorderWorkerSource =
                String(url);
          }
        };
      });
      const pictureUrl = await page.evaluate(() => {
        const picture = document.createElement("canvas");
        picture.width = picture.height = 24;
        const context = picture.getContext("2d")!;
        context.fillStyle = "rgb(0, 0, 255)";
        context.fillRect(0, 0, 24, 24);
        return picture.toDataURL("image/png");
      });
      pictureBytes = Buffer.from(pictureUrl.split(",")[1]!, "base64");
      await page.evaluate(async (prefix) => {
        document.body.innerHTML = `
          <style>#headline { color: rgb(20, 40, 60) }</style>
          <h1 id="headline">Initial visible title</h1>
          <p id="delayed-style-label">Stylesheet loaded after snapshot</p>
          <p id="added-style-label">Stylesheet inserted after snapshot</p>
          <ul id="items"><li id="a">Alpha</li><li id="b">Beta</li><li id="c">Gamma</li></ul>
          <input id="private-input" value="secret-initial-input">
          <p id="private-text" data-private>secret-initial-text</p>
          <div id="private-block" data-orange-block>secret-blocked-text</div>
          <div id="shadow-host"></div>
          <canvas id="paint" width="24" height="24"></canvas>
          <img id="picture" width="24" height="24">
        `;
        const shadow = document.querySelector("#shadow-host")!.attachShadow({ mode: "open" });
        shadow.innerHTML = `<style>#shadow-label { color: rgb(70, 80, 90) }</style><p id="shadow-label">Initial shadow title</p><p id="shadow-private" data-private>secret-shadow-text</p>`;
        const canvas = document.querySelector<HTMLCanvasElement>("#paint")!;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "rgb(255, 0, 0)";
        context.fillRect(0, 0, 24, 24);
        const picture = document.querySelector<HTMLImageElement>("#picture")!;
        picture.src = `${prefix}/image.png`;
        await picture.decode();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        // Page load has already completed. This request is deferred until the
        // first full snapshot is emitted, exercising its later load callback.
        const delayedStyle = document.createElement("link");
        delayedStyle.rel = "stylesheet";
        delayedStyle.href = `${prefix}/delayed.css`;
        document.head.append(delayedStyle);
      }, prefix);
      if (initialIframe) await addInitialIframe(page);
      if (format === "iife") await page.addScriptTag({ url: `${origin}${prefix}/bundle.js` });
      await page.evaluate(
        async ({ format, prefix, key }) => {
          const sdk: SdkVerificationWindow["OrangeReplay"] =
            format === "iife"
              ? (window as unknown as SdkVerificationWindow).OrangeReplay
              : await import(`${prefix}/bundle.js`);
          (window as unknown as SdkVerificationWindow).captureHandle = sdk.init({
            key,
            ingestUrl: `${location.origin}${prefix}/api`,
            maskTextSelector: "[data-private]",
            transport: "worker",
            flushMs: 1_000,
          });
        },
        { format, prefix, key: recorderKey },
      );

      const allEvents = () => batches.flatMap((batch) => batch.events);
      const captureText = () => JSON.stringify(allEvents());
      const canvasFrames = () =>
        allEvents().filter((event) => event.type === 3 && event.data?.source === 9);
      await expect
        .poll(() => allEvents().filter((event) => event.type === 2).length)
        .toBeGreaterThan(0);
      await expect.poll(() => captureText()).toContain("data:image/");
      if (captureCanvas) await expect.poll(() => canvasFrames().length).toBeGreaterThan(0);
      if (initialIframe) await expect.poll(() => captureText()).toContain("Initial iframe title");
      releaseDelayedStylesheet();
      if (!initialIframe)
        await expect.poll(() => captureText()).toContain("#delayed-style-label { color:");
      // Settle this callback before another document snapshot so the test proves
      // the CSS node identity independently from iframe snapshot generations.
      if (!initialIframe) await addInitialIframe(page);
      await expect.poll(() => captureText()).toContain("Initial iframe title");
      const initialTime = await page.evaluate(() => Date.now());
      await page.evaluate(async (prefix) => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        document.querySelector("#headline")!.textContent = "Updated visible title";
        document.querySelector<HTMLElement>("#headline")!.style.color = "rgb(40, 60, 80)";
        const items = document.querySelector("#items")!;
        items.prepend(document.querySelector("#c")!);
        document.querySelector("#b")!.remove();
        const added = document.createElement("li");
        added.textContent = "Delta";
        items.append(added);
        const input = document.querySelector<HTMLInputElement>("#private-input")!;
        input.value = "secret-updated-input";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("#private-text")!.textContent = "secret-updated-text";
        const shadow = document.querySelector("#shadow-host")!.shadowRoot!;
        shadow.querySelector("#shadow-label")!.textContent = "Updated shadow title";
        const nested =
          document.querySelector<HTMLIFrameElement>("#same-origin-frame")!.contentDocument!;
        nested.querySelector("#frame-label")!.textContent = "Updated iframe title";
        const frameInput = nested.querySelector<HTMLInputElement>("#frame-private")!;
        frameInput.value = "secret-updated-iframe-input";
        frameInput.dispatchEvent(new Event("input", { bubbles: true }));
        const canvas = document.querySelector<HTMLCanvasElement>("#paint")!;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "rgb(0, 255, 0)";
        context.fillRect(0, 0, 24, 24);
        const addedStyle = document.createElement("link");
        addedStyle.rel = "stylesheet";
        addedStyle.href = `${prefix}/added.css`;
        document.head.append(addedStyle);
      }, prefix);
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector("#delayed-style-label")!).color ===
            "rgb(11, 22, 33)" &&
          getComputedStyle(document.querySelector("#added-style-label")!).color ===
            "rgb(44, 55, 66)",
      );
      await page.evaluate(() => {
        // Continue recording after both stylesheet callbacks. A callback that
        // kills recording must fail on these later ordinary DOM/frame events.
        const late = document.createElement("iframe");
        late.id = "late-frame";
        document.body.append(late);
        const nested = late.contentDocument!;
        nested.open();
        nested.write("<!doctype html><html><body>Late iframe after stylesheets</body></html>");
        nested.close();
        document.querySelector("#headline")!.setAttribute("data-after-styles", "still-recording");
      });
      await expect.poll(() => captureText()).toContain("Late iframe after stylesheets");
      await expect.poll(() => captureText()).toContain("still-recording");
      await expect.poll(() => captureText()).toContain("Updated iframe title");
      await expect.poll(() => captureText()).toContain("Updated shadow title");
      await expect.poll(() => captureText()).toContain("Updated visible title");
      await page.locator("#headline").click();
      await expect
        .poll(() =>
          allEvents().some(
            (event) => event.type === 3 && event.data?.source === 2 && event.data.type === 2,
          ),
        )
        .toBe(true);
      if (captureCanvas) await expect.poll(() => canvasFrames().length).toBeGreaterThan(1);
      await page.evaluate(() => {
        // rrweb pause synchronizes events strictly before the target. A real
        // final marker leaves every checked mutation inside the recorded span.
        (window as unknown as SdkVerificationWindow).captureHandle.addCustomEvent(
          "verification-finished",
          {
            phase: "done",
          },
        );
      });
      const workerResult = await page.evaluate(async () => {
        const url = (window as unknown as { recorderWorkerSource: string }).recorderWorkerSource;
        const worker = new Worker(url, { type: "module" });
        try {
          const result = new Promise<unknown[]>((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = (event) => reject(new Error(event.message));
          });
          worker.postMessage([
            "a",
            [
              { type: 5, timestamp: 1, data: { tag: "good", payload: {} } },
              { type: 5, timestamp: 2, data: { tag: "bad", payload: { value: 1n } } },
            ],
          ]);
          worker.postMessage(["f", 4242]);
          const message = await result;
          return {
            dropped: message[4],
            payload: Array.from(new Uint8Array(message[2] as ArrayBuffer)),
          };
        } finally {
          worker.terminate();
        }
      });
      expect(workerResult.dropped).toBe(1);
      expect(JSON.parse(gunzipSync(new Uint8Array(workerResult.payload)).toString("utf8"))).toEqual(
        [{ type: 5, timestamp: 1, data: { tag: "good", payload: {} } }],
      );
      await page.evaluate(async () => {
        await (window as unknown as SdkVerificationWindow).captureHandle.stop();
      });
      expect(captureText()).not.toContain("secret-");
      for (const batch of batches) {
        expect(batch.index.appliedDomMasking).toMatchObject({
          inputs: "all",
          text: "selected",
          localRules: { text: true },
          rulesFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          canvas: captureCanvas,
        });
        expect(JSON.stringify(batch.index.appliedDomMasking)).not.toContain("data-private");
      }
      if (!captureCanvas) expect(canvasFrames()).toHaveLength(0);
      const uniqueBatches = [
        ...new Map(
          batches.map((batch) => [`${batch.index.s}/${batch.index.tab}/${batch.index.seq}`, batch]),
        ).values(),
      ];
      expect(uniqueBatches.length).toBe(batches.length);
      expect(new Set(batches.map((batch) => batch.index.tab)).size).toBe(1);
      const sourceImageRequests = imageRequests;
      const capturedPath = testInfo.outputPath("captured-sdk-events.json");
      await writeFile(
        capturedPath,
        JSON.stringify(
          {
            bundlePath,
            bundleBytes: bundle.length,
            bundleHash,
            format,
            captureCanvas,
            initialIframe,
            initialTime,
            batches: uniqueBatches.map(({ index, events }) => ({ index, events })),
          },
          null,
          2,
        ),
      );
      await testInfo.attach("captured-sdk-events", {
        contentType: "application/json",
        path: capturedPath,
      });

      // A new document removes every source node and SDK observer before replay.
      await page.goto(`${origin}${prefix}/replay`);
      await page.evaluate(
        async ({ helper, bodies }) => {
          const module = await import(helper);
          (window as unknown as SdkVerificationWindow).readVisibleReplay = module.readVisibleReplay;
          return await module.mountCapturedReplay(bodies);
        },
        { helper, bodies: uniqueBatches.map((batch) => batch.body) },
      );
      await page.evaluate(async (initialTime) => {
        const { player, state } = (window as unknown as SdkVerificationWindow).sdkVerification;
        await player.seek(initialTime - state.startedAt);
      }, initialTime);
      const readReplay = () =>
        page.evaluate(() => (window as unknown as SdkVerificationWindow).readVisibleReplay());
      await expect.poll(async () => (await readReplay()).title).toBe("Initial visible title");
      await expect.poll(async () => (await readReplay()).iframeText).toBe("Initial iframe title");
      await expect.poll(async () => (await readReplay()).shadowText).toBe("Initial shadow title");
      const initial = await readReplay();
      expect(initial.order).toEqual(["Alpha", "Beta", "Gamma"]);
      expect(initial.titleColor).toBe("rgb(20, 40, 60)");
      expect(initial.shadowColor).toBe("rgb(70, 80, 90)");
      expect(initial.iframeColor).toBe("rgb(100, 110, 120)");
      expect(initial.input).toMatch(/^\*+$/);
      expect(initial.maskedText).toMatch(/^\*+$/);
      expect(initial.shadowMasked).toMatch(/^\*+$/);
      expect(initial.iframeInput).toMatch(/^\*+$/);
      expect(initial.blockedText).toBe("");
      if (captureCanvas)
        await expect.poll(async () => dominant((await readReplay()).canvasPixel)).toBe("red");
      else expect(initial.canvasPixel).toEqual([0, 0, 0, 0]);
      await expect.poll(async () => dominant((await readReplay()).imagePixel)).toBe("blue");
      expect((await readReplay()).imageSource).toMatch(/^data:image\//);
      expect(initial.frameSandbox).toBe("allow-same-origin");
      expect(initial.policy).toContain("connect-src 'none'");
      await page.evaluate(async () => {
        const { player, state } = (window as unknown as SdkVerificationWindow).sdkVerification;
        await player.seek(state.endedAt - state.startedAt);
      });
      await expect.poll(async () => (await readReplay()).title).toBe("Updated visible title");
      await expect.poll(async () => (await readReplay()).iframeText).toBe("Updated iframe title");
      await expect.poll(async () => (await readReplay()).shadowText).toBe("Updated shadow title");
      const final = await readReplay();
      expect(final.order).toEqual(["Gamma", "Alpha", "Delta"]);
      expect(final.titleColor).toBe("rgb(40, 60, 80)");
      // Soft assertions retain a failing verdict and let the remaining fidelity
      // checks report their own outcomes for a baseline with a known CSS defect.
      expect.soft(final.delayedStyleColor).toBe("rgb(11, 22, 33)");
      expect.soft(final.addedStyleColor).toBe("rgb(44, 55, 66)");
      expect.soft(final.lateIframeText).toContain("Late iframe after stylesheets");
      expect(final.input).toMatch(/^\*+$/);
      expect(final.iframeInput).toMatch(/^\*+$/);
      expect(final.maskedText).toMatch(/^\*+$/);
      if (captureCanvas)
        await expect.poll(async () => dominant((await readReplay()).canvasPixel)).toBe("green");
      else expect(final.canvasPixel).toEqual([0, 0, 0, 0]);
      await expect.poll(async () => dominant((await readReplay()).imagePixel)).toBe("blue");
      expect(imageRequests).toBe(sourceImageRequests);
      expect(errors).toEqual([]);
      const finalState = await page.evaluate(
        () => (window as unknown as SdkVerificationWindow).sdkVerification.state,
      );
      expect(finalState.errors).toEqual([]);
      expect(finalState.workerStarts).toBe(1);
      expect(
        finalState.requests.filter((url: string) => url.includes("seg-000001.ors")),
      ).toHaveLength(1);
      const evidencePath = testInfo.outputPath("shipped-capture-replay-evidence.json");
      await writeFile(
        evidencePath,
        JSON.stringify(
          {
            bundlePath,
            bundleBytes: bundle.length,
            bundleHash,
            format,
            captureCanvas,
            initialIframe,
            batches: batches.length,
            events: allEvents().length,
            canvasFrames: canvasFrames().length,
            initial,
            final: await readReplay(),
            state: finalState,
          },
          null,
          2,
        ),
      );
      await testInfo.attach("shipped-capture-replay-evidence", {
        contentType: "application/json",
        path: evidencePath,
      });
      await page.screenshot({ path: testInfo.outputPath("replayed-final.png"), fullPage: true });
      await page.evaluate(() =>
        (window as unknown as SdkVerificationWindow).sdkVerification.player.destroy(),
      );
    });
  }
}

async function addInitialIframe(page: Page) {
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "same-origin-frame";
    document.body.append(frame);
    const nested = frame.contentDocument!;
    nested.open();
    nested.write(
      '<!doctype html><html><head><style>#frame-label { color: rgb(100, 110, 120) }</style></head><body><p id="frame-label">Initial iframe title</p><input id="frame-private" value="secret-iframe-input"></body></html>',
    );
    nested.close();
  });
}

function dominant(pixel: number[] | null | undefined) {
  if (!pixel || (pixel[3] ?? 0) < 200) return "empty";
  // WebP capture is lossy. Test the displayed solid color, not exact codec bytes.
  const channels = pixel.slice(0, 3);
  const winner = channels.indexOf(Math.max(...channels));
  if (
    (channels[winner] ?? 0) < 180 ||
    channels.filter((_, index) => index !== winner).some((value) => value > 60)
  )
    return "other";
  return ["red", "green", "blue"][winner];
}
