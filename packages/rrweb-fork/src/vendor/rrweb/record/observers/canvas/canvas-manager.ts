import type { Mirror } from "../../../../rrweb-snapshot/index.ts";
import type {
  DataURLOptions,
  blockClass,
  canvasMutationCallback,
  listenerHandler,
} from "../../../../rrweb-types/index.ts";
import { isBlocked } from "../../../utils.ts";

const DEFAULT_CANVAS_FRAMES_PER_SECOND = 2;
const MAX_CANVAS_CAPTURE_PIXELS = 2_000_000;
const MAX_CANVAS_SIDE = 8_192;
const MAX_CANVAS_FRAME_BYTES = 512 * 1_024;
const BASE64_CHUNK_BYTES = 32_768;

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
  private readonly lastFrameByCanvasId = new Map<number, string>();
  private frozen = false;
  private locked = false;
  private stopped = false;
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
      this.start();
    }
  }

  public reset(): void {
    this.pendingCanvasIds.clear();
    this.lastFrameByCanvasId.clear();
    this.resetObservers?.();
  }

  public freeze(): void {
    this.frozen = true;
  }

  public unfreeze(): void {
    this.frozen = false;
  }

  public lock(): void {
    this.locked = true;
  }

  public unlock(): void {
    this.locked = false;
  }

  private start(): void {
    const capture = (timestamp: number) => {
      if (this.stopped) return;

      if (
        !this.frozen &&
        !this.locked &&
        (this.lastCaptureTime === 0 || timestamp - this.lastCaptureTime >= this.captureIntervalMs)
      ) {
        this.lastCaptureTime = timestamp;
        this.captureVisibleCanvases();
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

  private captureVisibleCanvases(): void {
    for (const canvas of this.win.document.querySelectorAll("canvas")) {
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
      void this.captureCanvas(canvas, id).finally(() => this.pendingCanvasIds.delete(id));
    }
  }

  private async captureCanvas(canvas: HTMLCanvasElement, id: number): Promise<void> {
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

    const base64 = arrayBufferToBase64(await blob.arrayBuffer());
    if (base64 === this.lastFrameByCanvasId.get(id)) return;
    this.lastFrameByCanvasId.set(id, base64);

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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

function isSupportedCanvasImageType(type: string): boolean {
  return (
    type === "image/avif" || type === "image/jpeg" || type === "image/png" || type === "image/webp"
  );
}
