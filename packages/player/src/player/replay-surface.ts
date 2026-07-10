import type { Replayer } from "rrweb";
import "rrweb/dist/style.css";
import "../player-ui.css";
import {
  cleanReplayViewport,
  fitReplayToStage,
  replayViewportAt,
  type ReplayViewport,
} from "../geometry.ts";
import type { ReplayOverlay } from "../overlay.ts";
import { installReplayFramePolicy } from "../replay-security.ts";
import { createSecureReplayer } from "../secure-replayer.ts";
import type { ReplayEvent } from "../types.ts";

export interface ReplaySurfaceHost {
  onFinish(): void;
  onError(message: string, error?: unknown): void;
}

interface ReplaySurfaceOptions {
  container: HTMLElement;
  overlay: ReplayOverlay;
  host: ReplaySurfaceHost;
}

interface RebuildReplayOptions {
  events: readonly ReplayEvent[];
  speed: number;
  skipInactivity: boolean;
  following: boolean;
  currentTimestamp: number;
  playerOffset: number;
  shouldPlay: boolean;
}

interface ReplayerResizeEvent {
  width?: unknown;
  height?: unknown;
}

export class ReplaySurface {
  private readonly container: HTMLElement;
  private readonly overlay: ReplayOverlay;
  private readonly host: ReplaySurfaceHost;
  private readonly stageResizeObserver: ResizeObserver | undefined;
  private replayer: Replayer | undefined;
  private replayWrapper: HTMLDivElement | undefined;
  private replayViewport: ReplayViewport | undefined;

  constructor(options: ReplaySurfaceOptions) {
    this.container = options.container;
    this.overlay = options.overlay;
    this.host = options.host;
    ensureStage(options.container);
    if (typeof ResizeObserver === "function") {
      this.stageResizeObserver = new ResizeObserver(() => this.applyReplayLayout());
      this.stageResizeObserver.observe(options.container);
    }
  }

  get hasReplayer(): boolean {
    return this.replayer !== undefined;
  }

  rebuild(options: RebuildReplayOptions): void {
    this.destroyReplayerOnly();
    try {
      this.replayer = createSecureReplayer([...options.events], {
        root: this.container,
        speed: options.speed,
        skipInactive: options.skipInactivity,
        inactivePeriodThreshold: 5_000,
        showWarning: false,
        showDebug: false,
        mouseTail: false,
        triggerFocus: false,
        // The sanitizer only admits Orange Replay's fixed image-frame canvas
        // format. Arbitrary recorded canvas API calls never reach rrweb.
        UNSAFE_replayCanvas: true,
        useVirtualDom: true,
        liveMode: options.following,
        logger: {
          log() {
            /* keep the player headless */
          },
          warn() {
            /* keep the player headless */
          },
        },
      });
    } catch (error) {
      this.host.onError("Could not render replay events.", error);
      return;
    }

    const replayer = this.replayer;
    if (replayer === undefined) {
      return;
    }

    this.syncViewport(options.events, options.currentTimestamp);
    if (!this.attachReplayWrapper()) {
      replayer.destroy();
      this.replayer = undefined;
      this.host.onError("Could not install the replay security policy.");
      return;
    }
    replayer.on("resize", (event) => this.handleReplayerResize(event));
    replayer.on("finish", () => this.host.onFinish());

    if (options.following) {
      // Anchor the live baseline at the last buffered event: rrweb discards
      // addEvent() payloads older than the baseline, so "now" would drop
      // every frame that was recorded before it arrived here.
      replayer.startLive(options.events.at(-1)?.timestamp);
    } else if (options.shouldPlay) {
      replayer.play(options.playerOffset);
    } else {
      replayer.pause(options.playerOffset);
    }
  }

  addEvents(events: readonly ReplayEvent[]): void {
    if (this.replayer === undefined) {
      return;
    }

    for (const event of events) {
      try {
        this.replayer.addEvent(event);
      } catch (error) {
        this.host.onError("Could not add replay event.", error);
        this.destroyReplayerOnly();
        break;
      }
    }
  }

  syncViewport(events: readonly ReplayEvent[], currentTimestamp: number): void {
    const viewport = replayViewportAt(events, currentTimestamp);
    if (viewport !== null) {
      this.setReplayViewport(viewport);
    }
  }

  play(offset: number): void {
    this.replayer?.play(offset);
  }

  pause(): void {
    this.replayer?.pause();
  }

  setSpeed(speed: number): void {
    this.replayer?.setConfig({ speed });
  }

  setSkipInactivity(skipInactivity: boolean): void {
    this.replayer?.setConfig({
      skipInactive: skipInactivity,
      inactivePeriodThreshold: 5_000,
    });
  }

  currentTime(): number | null {
    return this.replayer?.getCurrentTime() ?? null;
  }

  destroyReplay(): void {
    this.destroyReplayerOnly();
    this.replayWrapper = undefined;
  }

  stop(): void {
    this.stageResizeObserver?.disconnect();
    this.destroyReplay();
  }

  private destroyReplayerOnly(): void {
    this.replayer?.destroy();
    this.replayer = undefined;
  }

  private handleReplayerResize(event: unknown): void {
    const resize = event as ReplayerResizeEvent;
    const viewport = cleanReplayViewport(resize.width, resize.height);
    if (viewport !== null) {
      this.setReplayViewport(viewport);
    }
  }

  private attachReplayWrapper(): boolean {
    const wrapper = this.replayer?.wrapper;
    if (wrapper === undefined) {
      return false;
    }

    this.replayWrapper = wrapper;
    const iframe = this.replayer?.iframe;
    if (iframe === undefined || !installReplayFramePolicy(iframe)) {
      this.replayWrapper = undefined;
      return false;
    }
    wrapper.style.position = "absolute";
    wrapper.style.margin = "0";
    wrapper.style.transformOrigin = "top left";
    wrapper.style.overflow = "hidden";
    this.applyReplayLayout();
    this.overlay.mount(wrapper);
    this.overlay.bringToFront();
    return true;
  }

  private setReplayViewport(viewport: ReplayViewport): void {
    if (
      this.replayViewport?.width === viewport.width &&
      this.replayViewport.height === viewport.height
    ) {
      this.applyReplayLayout();
      return;
    }

    this.replayViewport = viewport;
    this.applyReplayLayout();
  }

  private applyReplayLayout(): void {
    const wrapper = this.replayWrapper;
    const viewport = this.replayViewport;
    if (wrapper === undefined || viewport === undefined) {
      return;
    }

    const fit = fitReplayToStage(readStageSize(this.container), viewport);
    wrapper.style.width = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;
    wrapper.style.left = `${fit.left}px`;
    wrapper.style.top = `${fit.top}px`;
    wrapper.style.transform = `scale(${fit.scale})`;
  }
}

function ensureStage(container: HTMLElement): void {
  // Check the COMPUTED position: the host may position the container via
  // classes (e.g. Tailwind absolute inset-0) that inline styles would clobber.
  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }

  if (container.style.overflow.trim().length === 0) {
    container.style.overflow = "hidden";
  }
}

function readStageSize(container: HTMLElement): { width: number; height: number } {
  const rect = container.getBoundingClientRect();
  return {
    width: container.clientWidth > 0 ? container.clientWidth : rect.width,
    height: container.clientHeight > 0 ? container.clientHeight : rect.height,
  };
}
