import type { Mirror } from "../../../../rrweb-snapshot/index.ts";
import type {
  DataURLOptions,
  blockClass,
  canvasMutationCallback,
  listenerHandler,
} from "../../../../rrweb-types/index.ts";
import { isBlocked } from "../../../utils.ts";

declare const __ORANGE_REPLAY_SDK_PROFILE__: boolean | undefined;
const isOrangeReplaySdk =
  typeof __ORANGE_REPLAY_SDK_PROFILE__ !== "undefined" && __ORANGE_REPLAY_SDK_PROFILE__;
import { blobToBase64 } from "../blob-to-base64.ts";

const DEFAULT_CANVAS_FRAMES_PER_SECOND = 2;
const MAX_CANVAS_CAPTURE_PIXELS = 2_000_000;
const MAX_CANVAS_SIDE = 8_192;
const MAX_CANVAS_FRAME_BYTES = 512 * 1_024;

interface CanvasManagerOptions {
  recordCanvas: boolean;
  mutationCb: canvasMutationCallback;
  win: Window;
  blockClass: blockClass;
  blockSelector: string | null;
  mirror: Mirror;
  sampling?: "all" | number;
  dataURLOptions?: DataURLOptions;
}

/**
 * Records canvas pixels as small image frames instead of replaying canvas API
 * calls. The replay player can validate this fixed format without allowing
 * scripts or arbitrary drawing commands in the replay frame.
 */
export class CanvasManager {
  private readonly mutationCb: canvasMutationCallback;
  private readonly mirror: Mirror;
  private readonly win: Window;
  private readonly blockClass: blockClass;
  private readonly blockSelector: string | null;
  private readonly dataURLOptions: DataURLOptions;
  private readonly pendingCanvasIds = new Set<number>();
  private lastFrameHashByCanvas = new WeakMap<HTMLCanvasElement, string>();
  private readonly trackedCanvases = new Set<HTMLCanvasElement>();
  private trackedCanvasQueue: HTMLCanvasElement[] = [];
  private trackedCanvasCursor = 0;
  private snapshotGeneration = 0;
  private frozen = false;
  private stopped = true;
  private animationFrameId: number | undefined;
  private lastCaptureTime = 0;
  private readonly captureIntervalMs: number;

  public resetObservers?: listenerHandler;

  public constructor(options: CanvasManagerOptions) {
    this.mutationCb = options.mutationCb;
    this.mirror = options.mirror;
    this.win = options.win;
    this.blockClass = options.blockClass;
    this.blockSelector = options.blockSelector;
    this.dataURLOptions = options.dataURLOptions ?? {};
    const requestedFramesPerSecond =
      typeof options.sampling === "number" ? options.sampling : DEFAULT_CANVAS_FRAMES_PER_SECOND;
    const framesPerSecond = Math.min(4, Math.max(1, requestedFramesPerSecond));
    this.captureIntervalMs = 1_000 / framesPerSecond;

    if (options.recordCanvas) {
      this.stopped = false;
      this.start();
    }
  }

  public reset(): void {
    this.pendingCanvasIds.clear();
    this.lastFrameHashByCanvas = new WeakMap();
    this.trackedCanvases.clear();
    this.trackedCanvasQueue = [];
    this.trackedCanvasCursor = 0;
    this.resetObservers?.();
  }

  public prepareForFullSnapshot(): void {
    this.snapshotGeneration += 1;
    this.lastFrameHashByCanvas = new WeakMap();
    this.trackedCanvases.clear();
    this.trackedCanvasQueue = [];
    this.trackedCanvasCursor = 0;
  }

  public trackCanvas(node: Node): void {
    if (!this.stopped && node.nodeName === "CANVAS") {
      const canvas = node as HTMLCanvasElement;
      if (this.trackedCanvases.has(canvas)) return;
      this.trackedCanvases.add(canvas);
      this.trackedCanvasQueue.push(canvas);
    }
  }

  public freeze(): void {
    if (!isOrangeReplaySdk) this.frozen = true;
  }

  public unfreeze(): void {
    if (!isOrangeReplaySdk) this.frozen = false;
  }

  private start(): void {
    const capture = (timestamp: number) => {
      if (this.stopped) return;

      if (
        (isOrangeReplaySdk || !this.frozen) &&
        (this.lastCaptureTime === 0 || timestamp - this.lastCaptureTime >= this.captureIntervalMs)
      ) {
        this.lastCaptureTime = timestamp;
        this.captureNextCanvas();
      }

      this.animationFrameId = this.win.requestAnimationFrame(capture);
    };

    this.animationFrameId = this.win.requestAnimationFrame(capture);
    this.resetObservers = () => {
      if (this.stopped) return;
      this.stopped = true;
      if (this.animationFrameId !== undefined) {
        this.win.cancelAnimationFrame(this.animationFrameId);
      }
    };
  }

  private captureNextCanvas(): void {
    // Check only a small number and start at most one encoder per tick. This
    // keeps pages with many canvases from creating an unbounded burst of work.
    for (let checked = 0; checked < 8 && this.trackedCanvasQueue.length > 0; checked += 1) {
      if (this.trackedCanvasCursor >= this.trackedCanvasQueue.length) {
        this.trackedCanvasCursor = 0;
      }
      const index = this.trackedCanvasCursor;
      const canvas = this.trackedCanvasQueue[index]!;
      if (!canvas.isConnected) {
        this.trackedCanvases.delete(canvas);
        const lastCanvas = this.trackedCanvasQueue.pop();
        if (lastCanvas !== undefined && index < this.trackedCanvasQueue.length) {
          this.trackedCanvasQueue[index] = lastCanvas;
        }
        continue;
      }
      this.trackedCanvasCursor = index + 1;
      if (
        isBlocked(canvas, this.blockClass, this.blockSelector, true) ||
        canvas.width <= 0 ||
        canvas.height <= 0 ||
        canvas.width > MAX_CANVAS_SIDE ||
        canvas.height > MAX_CANVAS_SIDE ||
        canvas.width * canvas.height > 16_000_000
      ) {
        continue;
      }

      const id = this.mirror.getId(canvas);
      if (id <= 0 || this.pendingCanvasIds.has(id)) {
        continue;
      }

      this.pendingCanvasIds.add(id);
      const generation = this.snapshotGeneration;
      void this.captureCanvas(canvas, id, generation).finally(() =>
        this.pendingCanvasIds.delete(id),
      );
      return;
    }
  }

  private async captureCanvas(
    canvas: HTMLCanvasElement,
    id: number,
    generation: number,
  ): Promise<void> {
    const sourceWidth = canvas.width;
    const sourceHeight = canvas.height;
    const captureCanvas = makeCaptureCanvas(canvas, MAX_CANVAS_CAPTURE_PIXELS);
    if (captureCanvas === null) return;

    let blob: Blob | null;
    try {
      blob = await canvasToBlob(
        captureCanvas,
        this.dataURLOptions.type ?? "image/webp",
        this.dataURLOptions.quality ?? 0.62,
      );
    } catch {
      // A canvas containing a cross-origin image can be unreadable. Skipping it
      // is safer than breaking the host page or the whole recording.
      return;
    }

    if (blob === null || blob.size === 0 || blob.size > MAX_CANVAS_FRAME_BYTES) return;
    if (!isSupportedCanvasImageType(blob.type)) return;

    const base64 = await blobToBase64(blob, this.win);
    if (
      this.stopped ||
      generation !== this.snapshotGeneration ||
      !canvas.isConnected ||
      !this.mirror.isActiveNode(canvas) ||
      this.mirror.getId(canvas) !== id ||
      canvas.width !== sourceWidth ||
      canvas.height !== sourceHeight ||
      isBlocked(canvas, this.blockClass, this.blockSelector, true)
    )
      return;
    const frameHash = `${base64.length}:${hashString(base64)}`;
    if (frameHash === this.lastFrameHashByCanvas.get(canvas)) return;
    this.lastFrameHashByCanvas.set(canvas, frameHash);

    this.mutationCb({
      id,
      type: 0,
      commands: [
        { property: "clearRect", args: [0, 0, sourceWidth, sourceHeight] },
        {
          property: "drawImage",
          args: [
            {
              rr_type: "ImageBitmap",
              args: [
                {
                  rr_type: "Blob",
                  data: [{ rr_type: "ArrayBuffer", base64 }],
                  type: blob.type,
                },
              ],
            },
            0,
            0,
            sourceWidth,
            sourceHeight,
          ],
        },
      ],
    });
  }
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function makeCaptureCanvas(source: HTMLCanvasElement, maxPixels: number): HTMLCanvasElement | null {
  if (source.width * source.height <= maxPixels) return source;

  const scale = Math.sqrt(maxPixels / (source.width * source.height));
  const width = Math.max(1, Math.floor(source.width * scale));
  const height = Math.max(1, Math.floor(source.height * scale));
  const target = source.ownerDocument.createElement("canvas");
  target.width = width;
  target.height = height;
  const context = target.getContext("2d");
  if (context === null) return null;

  try {
    context.drawImage(source, 0, 0, width, height);
    return target;
  } catch {
    return null;
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(resolve, type, quality);
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Canvas image capture failed."));
    }
  });
}

function isSupportedCanvasImageType(type: string): boolean {
  return (
    type === "image/avif" || type === "image/jpeg" || type === "image/png" || type === "image/webp"
  );
}
