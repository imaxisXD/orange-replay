import { OrangePlayer } from "../../../packages/player/src/player.ts";
import { buildSegment, decodeIngestBody } from "../../../packages/shared/src/wire.ts";
import type { InitOptions, OrangeReplayHandle } from "../../../packages/sdk/src/types.ts";

interface ReplayVerificationState {
  errors: string[];
  workerStarts: number;
  requests: string[];
  startedAt: number;
  endedAt: number;
}

export type SdkVerificationWindow = Window & {
  OrangeReplay: { init(options: InitOptions): OrangeReplayHandle };
  captureHandle: OrangeReplayHandle;
  sdkVerification: { player: OrangePlayer; state: ReplayVerificationState };
  readVisibleReplay: typeof readVisibleReplay;
};

// The API fixture preserves original SDK wire bytes. Player decoding, sanitizing,
// iframe security and rrweb rendering are the actual production implementations.
export async function mountCapturedReplay(bodies: number[][]) {
  const batches = bodies.map((body) => new Uint8Array(body));
  const indexes = batches.map((body) => decodeIngestBody(body).index);
  const bytes = buildSegment(batches);
  const startedAt = Math.min(...indexes.map((index) => index.t0));
  const endedAt = Math.max(...indexes.map((index) => index.t1));
  const first = indexes[0]!;
  const key = `p/verification/${first.s}/seg-000001.ors`;
  const manifest = {
    v: 1,
    sessionId: first.s,
    projectId: "verification",
    orgId: "verification",
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    segments: [
      {
        key,
        bytes: bytes.byteLength,
        t0: startedAt,
        t1: endedAt,
        batches: batches.length,
        checkpoints: indexes.flatMap((index, batch) =>
          (index.checkpointTimestamps ?? []).map((timestamp) => ({
            timestamp,
            batch,
            tab: index.tab,
          })),
        ),
      },
    ],
    timeline: [],
    counts: { batches: batches.length, events: 0, clicks: 0, errors: 0, rages: 0, navs: 0 },
    bytes: bytes.byteLength,
    flags: 0,
    attrs: {},
  };
  document.body.replaceChildren();
  const stage = document.createElement("div");
  stage.id = "sdk-verification-stage";
  stage.style.cssText =
    "position:relative;width:1000px;height:750px;overflow:hidden;background:white";
  document.body.append(stage);
  const state = {
    errors: [] as string[],
    workerStarts: 0,
    requests: [] as string[],
    startedAt,
    endedAt,
  };
  class VerifiedWorker extends Worker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      state.workerStarts += 1;
    }
  }
  const player = new OrangePlayer(stage, {
    projectId: manifest.projectId,
    sessionId: manifest.sessionId,
    worker: { WorkerCtor: VerifiedWorker, allowSynchronousFallback: false },
    api: {
      fetch: async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        state.requests.push(url);
        if (url.endsWith("/manifest")) return Response.json(manifest);
        if (url.includes("seg-000001.ors")) return new Response(bytes as unknown as BodyInit);
        return new Response("Not found", { status: 404 });
      },
    },
  });
  player.on("error", (error) => state.errors.push(error.message));
  Object.assign(window, { sdkVerification: { player, state } });
  await player.ready();
  return state;
}

export function readVisibleReplay() {
  const stage = document.querySelector("#sdk-verification-stage");
  const replayFrame = stage?.querySelector("iframe");
  const replayDocument = replayFrame?.contentDocument;
  const shadow = replayDocument?.querySelector("#shadow-host")?.shadowRoot;
  const nested =
    replayDocument?.querySelector<HTMLIFrameElement>("#same-origin-frame")?.contentDocument;
  const canvas = replayDocument?.querySelector<HTMLCanvasElement>("#paint");
  const image = replayDocument?.querySelector<HTMLImageElement>("#picture");
  let imagePixel: number[] | null = null;
  if (image?.complete && image.naturalWidth > 0) {
    const sample = document.createElement("canvas");
    sample.width = sample.height = 1;
    const context = sample.getContext("2d")!;
    context.drawImage(image, 0, 0, 1, 1);
    imagePixel = Array.from(context.getImageData(0, 0, 1, 1).data);
  }
  const color = (element: Element | null | undefined) =>
    element ? element.ownerDocument.defaultView!.getComputedStyle(element).color : null;
  return {
    title: replayDocument?.querySelector("#headline")?.textContent,
    order: Array.from(
      replayDocument?.querySelectorAll("#items > li") ?? [],
      (node) => node.textContent,
    ),
    input: replayDocument?.querySelector<HTMLInputElement>("#private-input")?.value,
    maskedText: replayDocument?.querySelector("#private-text")?.textContent,
    blockedText: replayDocument?.querySelector("#private-block")?.textContent ?? "",
    shadowText: shadow?.querySelector("#shadow-label")?.textContent,
    shadowColor: color(shadow?.querySelector("#shadow-label")),
    shadowMasked: shadow?.querySelector("#shadow-private")?.textContent,
    iframeText: nested?.querySelector("#frame-label")?.textContent,
    iframeColor: color(nested?.querySelector("#frame-label")),
    iframeInput: nested?.querySelector<HTMLInputElement>("#frame-private")?.value,
    titleColor: color(replayDocument?.querySelector("#headline")),
    delayedStyleColor: color(replayDocument?.querySelector("#delayed-style-label")),
    addedStyleColor: color(replayDocument?.querySelector("#added-style-label")),
    lateIframeText:
      replayDocument?.querySelector<HTMLIFrameElement>("#late-frame")?.contentDocument?.body
        ?.textContent,
    canvasPixel: canvas ? Array.from(canvas.getContext("2d")!.getImageData(8, 8, 1, 1).data) : null,
    imagePixel,
    imageSource: image?.getAttribute("src"),
    frameSandbox: replayFrame?.getAttribute("sandbox"),
    policy: replayDocument
      ?.querySelector("meta[data-orange-replay-policy]")
      ?.getAttribute("content"),
  };
}
