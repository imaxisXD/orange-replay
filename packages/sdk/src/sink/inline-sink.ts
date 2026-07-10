import {
  FLAG_UNCOMPRESSED,
  HDR_FLAGS,
  HDR_KEY,
  HDR_SEQ,
  HDR_SESSION,
  HDR_TAB,
  SDK_FLUSH_DEFAULT_MS,
} from "@orange-replay/shared/constants";
import type { IndexEvent } from "@orange-replay/shared/types";
import { encodeIngestBody } from "@orange-replay/shared/wire";
import { EventType, type eventWithTime } from "@orange-replay/rrweb-fork";
import { markSdkInternalError } from "../internal-error.ts";
import { readAck } from "../pipeline/transport.ts";
import { scrubUrl } from "../scrub.ts";
import type { SessionManager } from "../session.ts";
import { IndexEventBuffer } from "../sidecar.ts";
import type { RecorderConfig } from "../types.ts";
import { buildBatchIndex } from "./batch-index.ts";
import type { FlushReason, InlineSinkOptions, Sink } from "./contracts.ts";

export class InlineSink implements Sink {
  private readonly config: RecorderConfig;
  private readonly session: SessionManager;
  private readonly window: Window;
  private readonly fetchFn: typeof fetch;
  private readonly onSessionClosed?: () => void;
  private readonly onCheckpointRequested?: () => void;
  private readonly encoder = new TextEncoder();
  private readonly indexEvents = new IndexEventBuffer();
  private rrwebEvents: eventWithTime[] = [];
  private currentUrl: string;
  private flushMs: number;
  private timerId: number | undefined;
  private stopped = false;
  private flushing: Promise<void> | undefined;
  private warnedAboutInternalError = false;

  constructor(options: InlineSinkOptions) {
    this.config = options.config;
    this.session = options.session;
    this.window = options.window;
    this.fetchFn = options.fetch ?? options.window.fetch.bind(options.window);
    this.onSessionClosed = options.onSessionClosed;
    this.onCheckpointRequested = options.onCheckpointRequested;
    this.currentUrl = scrubUrl(options.window.location.href, options.config.allowUrlParams);
    this.flushMs = options.config.flushMs || SDK_FLUSH_DEFAULT_MS;
  }

  start(): void {
    this.scheduleTimer();
    this.window.document.addEventListener("visibilitychange", this.onVisibilityChange, true);
    this.window.addEventListener("pagehide", this.onPageHide, true);
  }

  addRrwebEvent(event: eventWithTime): void {
    if (this.stopped) {
      return;
    }

    this.rrwebEvents.push(event);
  }

  addIndexEvent(event: IndexEvent): void {
    if (this.stopped) {
      return;
    }

    this.indexEvents.add(event);
  }

  onNavigation(url: string): void {
    this.currentUrl = scrubUrl(url, this.config.allowUrlParams);
  }

  flush(reason: FlushReason): Promise<void> {
    if (this.flushing !== undefined) {
      return this.flushing;
    }

    this.clearTimer();
    this.flushing = this.flushNow(reason)
      .catch((error) => {
        this.disableAfterInternalError(error);
      })
      .finally(() => {
        this.flushing = undefined;
        if (!this.stopped) {
          this.scheduleTimer();
        }
      });

    return this.flushing;
  }

  async prepareForSessionRotation(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.flushing !== undefined) {
      await this.flushing;
    }

    await this.flush("manual");
  }

  resetAfterSessionRotation(): void {
    this.rrwebEvents = [];
    this.indexEvents.drain();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.clearTimer();
    this.window.document.removeEventListener("visibilitychange", this.onVisibilityChange, true);
    this.window.removeEventListener("pagehide", this.onPageHide, true);
    await this.flush("manual");
  }

  getFlushMs(): number {
    return this.flushMs;
  }

  droppedIndexEventCount(): number {
    return this.indexEvents.droppedCount();
  }

  private async flushNow(reason: FlushReason): Promise<void> {
    const rrwebEvents = this.rrwebEvents;
    const indexEvents = this.indexEvents.drain();
    this.rrwebEvents = [];

    if (rrwebEvents.length === 0 && indexEvents.length === 0) {
      return;
    }

    const seq = this.session.nextSeq();
    const index = buildBatchIndex({
      session: this.session,
      seq,
      currentUrl: this.currentUrl,
      rrwebEvents: rrwebEvents.map((event) => ({
        timestamp: event.timestamp,
        ...(event.type === EventType.FullSnapshot ? { fullSnapshot: true } : {}),
      })),
      indexEvents,
    });
    const payload = this.encoder.encode(JSON.stringify(rrwebEvents));
    const body = encodeIngestBody(index, payload);
    const response = await this.fetchFn(`${this.config.ingestUrl}/v1/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        [HDR_KEY]: this.config.key,
        [HDR_SESSION]: index.s,
        [HDR_TAB]: index.tab,
        [HDR_SEQ]: String(index.seq),
        [HDR_FLAGS]: String(FLAG_UNCOMPRESSED),
      },
      body: body as unknown as BodyInit,
      keepalive: reason === "pagehide",
    });

    const ack = await readAck(response);
    if (ack.checkpoint === true) {
      this.onCheckpointRequested?.();
    }

    if (ack.drop === true) {
      this.stopAfterServerDrop();
      return;
    }

    if (ack.closed === true) {
      this.handleSessionClosed();
    }

    if (Number.isFinite(ack.flushMs) && ack.flushMs > 0) {
      this.flushMs = Math.floor(ack.flushMs);
    }
  }

  private stopAfterServerDrop(): void {
    this.stopped = true;
    this.clearTimer();
    this.window.document.removeEventListener("visibilitychange", this.onVisibilityChange, true);
    this.window.removeEventListener("pagehide", this.onPageHide, true);
    this.rrwebEvents = [];
    this.indexEvents.drain();
  }

  private handleSessionClosed(): void {
    if (this.onSessionClosed !== undefined) {
      this.onSessionClosed();
      return;
    }

    this.session.rotate();
    this.resetAfterSessionRotation();
  }

  private disableAfterInternalError(error: unknown): void {
    if (!this.warnedAboutInternalError) {
      this.warnedAboutInternalError = true;
      console.warn(
        "Orange Replay recorder stopped after an internal pipeline error.",
        markSdkInternalError(error),
      );
    }

    this.stopped = true;
    this.clearTimer();
    this.window.document.removeEventListener("visibilitychange", this.onVisibilityChange, true);
    this.window.removeEventListener("pagehide", this.onPageHide, true);
    this.rrwebEvents = [];
    this.indexEvents.drain();
  }

  private scheduleTimer(): void {
    this.clearTimer();
    this.timerId = this.window.setTimeout(() => {
      void this.flush("timer");
    }, this.flushMs);
  }

  private clearTimer(): void {
    if (this.timerId !== undefined) {
      this.window.clearTimeout(this.timerId);
      this.timerId = undefined;
    }
  }

  private readonly onVisibilityChange = (): void => {
    if (this.window.document.visibilityState === "hidden") {
      void this.flush("visibility");
    }
  };

  private readonly onPageHide = (): void => {
    void this.flush("pagehide");
  };
}
