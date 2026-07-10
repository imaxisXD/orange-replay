import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const stateFile = new URL("../.playwright-state.json", import.meta.url);
const replayProbeUrl = "http://127.0.0.1:9/orange-replay-probe";

test("renders recorded CSS while the replay frame blocks every network escape", async ({
  page,
}) => {
  const state = JSON.parse(await readFile(stateFile, "utf8")) as { demoUrl: string };
  const replayEgressRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(replayProbeUrl)) {
      replayEgressRequests.push(request.url());
    }
  });

  await page.goto(`${state.demoUrl}?sampleRate=0`);
  await page.evaluate(async () => {
    document.body.replaceChildren();
    const root = document.createElement("div");
    root.id = "replay-proof-root";
    document.body.append(root);
    const modulePath = "/src/replay-proof.ts";
    const { mountReplayProof } = await import(/* @vite-ignore */ modulePath);
    mountReplayProof(root);
  });

  const replayFrame = page.frameLocator("#replay-proof-root iframe");
  await expect(replayFrame.getByText("Replay fidelity proof")).toBeVisible();
  await expect
    .poll(() =>
      replayFrame.locator(".layout").evaluate((element) => {
        const style = window.getComputedStyle(element);
        return {
          display: style.display,
          columns: style.gridTemplateColumns,
          gap: style.gap,
          padding: style.padding,
        };
      }),
    )
    .toEqual({ display: "grid", columns: "240px 668px", gap: "24px", padding: "32px" });

  await expect(
    replayFrame
      .locator(".card")
      .first()
      .evaluate((element) => {
        const style = window.getComputedStyle(element);
        return {
          minHeight: style.minHeight,
          padding: style.padding,
          border: style.borderTopWidth,
          borderRadius: style.borderRadius,
          background: style.backgroundColor,
        };
      }),
  ).resolves.toEqual({
    minHeight: "180px",
    padding: "28px",
    border: "2px",
    borderRadius: "12px",
    background: "rgb(30, 41, 59)",
  });

  expect(await page.locator("#replay-proof-root iframe").getAttribute("sandbox")).toBe(
    "allow-same-origin",
  );

  await replayFrame.locator("body").evaluate((body, probeUrl) => {
    body.style.setProperty("background-image", `url(${probeUrl}?css)`);

    const image = document.createElement("img");
    image.src = `${probeUrl}?image`;
    body.append(image);

    const frame = document.createElement("iframe");
    frame.src = `${probeUrl}?frame`;
    body.append(frame);

    const object = document.createElement("object");
    object.data = `${probeUrl}?object`;
    body.append(object);

    const script = document.createElement("script");
    script.src = `${probeUrl}?script`;
    body.append(script);
  }, replayProbeUrl);

  await page.waitForTimeout(500);
  expect(replayEgressRequests).toEqual([]);
});
