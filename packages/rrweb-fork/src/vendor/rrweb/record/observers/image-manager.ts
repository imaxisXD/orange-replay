import type { Mirror } from "../../../rrweb-snapshot/index.ts";
import type { DataURLOptions, blockClass, mutationCallBack } from "../../../rrweb-types/index.ts";
import { isBlocked, isNodeInSubtrees } from "../../utils.ts";
import { blobToBase64 } from "./blob-to-base64.ts";

interface ImageManagerOptions {
  inlineImages: boolean;
  mutationCb: mutationCallBack;
  win: Window;
  blockClass: blockClass;
  blockSelector: string | null;
  mirror: Mirror;
  dataURLOptions?: DataURLOptions;
}

/**
 * Seals image pixels into replay events without using synchronous
 * canvas.toDataURL() during the full DOM snapshot.
 */
export class ImageManager {
  private readonly mutationCb: mutationCallBack;
  private readonly mirror: Mirror;
  private readonly win: Window;
  private readonly blockClass: blockClass;
  private readonly blockSelector: string | null;
  private readonly dataURLOptions: DataURLOptions;
  private lastSourceByImage = new WeakMap<HTMLImageElement, string>();
  private imageQueue: HTMLImageElement[] = [];
  private queuedImages = new WeakSet<HTMLImageElement>();
  private waitingImages = new Map<HTMLImageElement, () => void>();
  private snapshotGeneration = 0;
  private paused = false;
  private stopped = true;
  private scheduled = false;

  public constructor(options: ImageManagerOptions) {
    this.mutationCb = options.mutationCb;
    this.mirror = options.mirror;
    this.win = options.win;
    this.blockClass = options.blockClass;
    this.blockSelector = options.blockSelector;
    this.dataURLOptions = options.dataURLOptions ?? {};

    if (options.inlineImages) this.stopped = false;
  }

  public reset(): void {
    this.stopped = true;
    this.snapshotGeneration += 1;
    this.lastSourceByImage = new WeakMap();
    this.imageQueue = [];
    this.queuedImages = new WeakSet();
    for (const cleanup of this.waitingImages.values()) cleanup();
    this.waitingImages.clear();
  }

  public prepareForFullSnapshot(): void {
    this.snapshotGeneration += 1;
    this.paused = true;
    this.lastSourceByImage = new WeakMap();
    this.imageQueue = [];
    this.queuedImages = new WeakSet();
    for (const cleanup of this.waitingImages.values()) cleanup();
    this.waitingImages.clear();
  }

  public finishFullSnapshot(): void {
    this.paused = false;
    this.scheduleNextCapture();
  }

  public trackImage(node: Node): void {
    if (node.nodeName === "IMG") this.queueImage(node as HTMLImageElement);
  }

  public removeContainedImages(roots: readonly Node[]): void {
    if (roots.length === 0) return;
    for (const [image, cleanup] of this.waitingImages) {
      if (!isNodeInSubtrees(image, roots)) continue;
      cleanup();
      this.waitingImages.delete(image);
    }
    this.imageQueue = this.imageQueue.filter((image) => !isNodeInSubtrees(image, roots));
    this.queuedImages = new WeakSet(this.imageQueue);
  }

  private queueImage(image: HTMLImageElement): void {
    if (this.stopped) return;
    if (!image.complete) {
      if (this.waitingImages.has(image)) return;
      const handleLoad = () => {
        image.removeEventListener("load", handleLoad);
        this.waitingImages.delete(image);
        this.queueImage(image);
      };
      const cleanup = () => image.removeEventListener("load", handleLoad);
      this.waitingImages.set(image, cleanup);
      image.addEventListener("load", handleLoad, { once: true });
      return;
    }
    if (this.queuedImages.has(image)) return;
    this.queuedImages.add(image);
    this.imageQueue.push(image);
    this.scheduleNextCapture();
  }

  private scheduleNextCapture(): void {
    if (this.stopped || this.paused || this.imageQueue.length === 0 || this.scheduled) {
      return;
    }

    this.scheduled = true;
    const run = () => {
      void this.captureNextLoadedImage().finally(() => {
        this.scheduled = false;
        this.scheduleNextCapture();
      });
    };

    const requestIdleCallback = Reflect.get(this.win, "requestIdleCallback") as
      | ((callback: IdleRequestCallback, options?: IdleRequestOptions) => number)
      | undefined;
    if (requestIdleCallback !== undefined) {
      requestIdleCallback.call(this.win, run, { timeout: 2_000 });
    } else {
      this.win.requestAnimationFrame(run);
    }
  }

  private async captureNextLoadedImage(): Promise<void> {
    if (this.stopped || this.paused) return;
    // Bound each callback even when a page contains thousands of unloaded or
    // blocked images. A later load event queues each image again when ready.
    for (let checked = 0; checked < 32 && this.imageQueue.length > 0; checked += 1) {
      const image = this.imageQueue.pop()!;
      this.queuedImages.delete(image);
      if (
        !image.isConnected ||
        isBlocked(image, this.blockClass, this.blockSelector, true) ||
        !image.complete ||
        image.naturalWidth <= 0 ||
        image.naturalHeight <= 0
      ) {
        continue;
      }

      const id = this.mirror.getId(image);
      const source = `${image.currentSrc || image.src}|${image.naturalWidth}x${image.naturalHeight}`;
      if (id <= 0 || this.lastSourceByImage.get(image) === source) continue;

      this.lastSourceByImage.set(image, source);
      const generation = this.snapshotGeneration;
      await this.captureImage(image, id, generation, source);
      return;
    }
  }

  private async captureImage(
    image: HTMLImageElement,
    id: number,
    generation: number,
    source: string,
  ): Promise<void> {
    const sourcePixels = image.naturalWidth * image.naturalHeight;
    const scale = sourcePixels > 4_000_000 ? Math.sqrt(4_000_000 / sourcePixels) : 1;
    const canvas = image.ownerDocument.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (context === null) return;
    try {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(
          resolve,
          this.dataURLOptions.type ?? "image/webp",
          this.dataURLOptions.quality ?? 0.62,
        ),
      );
      if (blob === null || blob.size === 0 || blob.size > 1_500_000) return;
      const base64 = await blobToBase64(blob, this.win);
      const currentSource = `${image.currentSrc || image.src}|${image.naturalWidth}x${image.naturalHeight}`;
      if (
        this.stopped ||
        generation !== this.snapshotGeneration ||
        !image.isConnected ||
        !this.mirror.isActiveNode(image) ||
        this.mirror.getId(image) !== id ||
        source !== currentSource ||
        isBlocked(image, this.blockClass, this.blockSelector, true)
      )
        return;
      this.mutationCb({
        texts: [],
        attributes: [
          { id, attributes: { src: `data:${blob.type};base64,${base64}`, srcset: null } },
        ],
        removes: [],
        adds: [],
      });
    } catch {
      // Cross-origin images without CORS cannot be read. Keep them blank in
      // replay instead of making the replay contact the recorded website.
    }
  }
}
