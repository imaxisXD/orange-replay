import {
  addCustomEvent as addRrwebCustomEvent,
  record,
  takeFullSnapshot as takeRrwebFullSnapshot,
  type eventWithTime,
  type recordOptions,
} from "@orange-replay/rrweb-fork";
import { scrubUrl } from "./scrub.ts";
import type { Sink } from "./sink.ts";
import type { RecorderConfig } from "./types.ts";

const DEFAULT_BLOCK_SELECTOR = "[data-orange-block]";
const DEFAULT_IGNORE_SELECTOR = "[data-orange-ignore]";
const CHECKOUT_EVERY_MS = 4 * 60 * 1000;
const CHECKOUT_EVERY_NTH = 5_000;

export interface RecorderOptions {
  config: RecorderConfig;
  sink: Sink;
}

const MAX_PENDING_CUSTOM_EVENTS = 20;

export class Recorder {
  private readonly config: RecorderConfig;
  private readonly sink: Sink;
  private stopRecord?: () => void;
  private disabled = false;
  private warned = false;
  private readonly pendingCustomEvents: Array<{ name: string; payload: unknown }> = [];

  constructor(options: RecorderOptions) {
    this.config = options.config;
    this.sink = options.sink;
  }

  start(): void {
    if (this.disabled || this.stopRecord !== undefined) {
      return;
    }

    try {
      const options = buildRecordOptions(
        this.config,
        (event) => this.emit(event),
        (error) => this.kill(error),
      );
      this.stopRecord = record(options);
      if (this.stopRecord === undefined) {
        this.disabled = true;
        return;
      }
      this.drainPendingCustomEvents();
    } catch (error) {
      this.kill(error);
    }
  }

  stop(): void {
    if (this.stopRecord === undefined) {
      return;
    }

    const stopRecord = this.stopRecord;
    this.stopRecord = undefined;

    try {
      stopRecord();
    } catch (error) {
      this.kill(error);
    }
  }

  addCustomEvent(name: string, payload: unknown): void {
    if (this.disabled) {
      return;
    }

    // Before rrweb is recording (initial start or a rotation-restart gap),
    // custom events queue instead of reaching rrweb — its "please add custom
    // event after start recording" throw is a recoverable ordering issue,
    // never a reason to kill the session.
    if (this.stopRecord === undefined) {
      this.queueCustomEvent(name, payload);
      return;
    }

    try {
      addRrwebCustomEvent(name, payload);
    } catch (error) {
      if (isPreStartCustomEventError(error)) {
        this.queueCustomEvent(name, payload);
        return;
      }
      this.kill(error);
    }
  }

  private queueCustomEvent(name: string, payload: unknown): void {
    if (this.pendingCustomEvents.length >= MAX_PENDING_CUSTOM_EVENTS) {
      return;
    }
    this.pendingCustomEvents.push({ name, payload });
  }

  private drainPendingCustomEvents(): void {
    const pending = this.pendingCustomEvents.splice(0);
    for (const entry of pending) {
      try {
        addRrwebCustomEvent(entry.name, entry.payload);
      } catch {
        // Still not emitting (or payload unserializable) — drop, never kill.
      }
    }
  }

  takeFullSnapshot(): void {
    if (this.disabled || this.stopRecord === undefined) {
      return;
    }

    try {
      takeRrwebFullSnapshot(true);
    } catch (error) {
      this.kill(error);
    }
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  private emit(event: eventWithTime): void {
    if (this.disabled) {
      return;
    }

    try {
      this.sink.addRrwebEvent(scrubMetaHref(event, this.config.allowUrlParams));
    } catch (error) {
      this.kill(error);
    }
  }

  private kill(error: unknown): void {
    if (!this.warned) {
      this.warned = true;
      console.warn("Orange Replay recorder stopped after an internal error.", error);
    }

    this.disabled = true;
    const stopRecord = this.stopRecord;
    this.stopRecord = undefined;

    if (stopRecord !== undefined) {
      try {
        stopRecord();
      } catch {
        /* recorder is already being disabled */
      }
    }
  }
}

export function buildRecordOptions(
  config: RecorderConfig,
  emit: (event: eventWithTime) => void,
  onError?: (error: unknown) => void,
): recordOptions<eventWithTime> {
  return {
    emit,
    maskAllInputs: true,
    blockSelector: mergeSelectors(DEFAULT_BLOCK_SELECTOR, config.blockSelector),
    ignoreSelector: mergeSelectors(DEFAULT_IGNORE_SELECTOR, config.ignoreSelector),
    maskTextSelector: config.maskTextSelector,
    // Images are sealed into the recording so the replay frame never needs to
    // contact the recorded site or a third party.
    inlineImages: true,
    // Canvas pixels cannot be text-masked, so this remains an explicit project
    // setting. Frames are capped, deduplicated WebP images rather than canvas
    // API calls.
    recordCanvas: config.capture.canvas,
    sampling: { canvas: 2 },
    dataURLOptions: { type: "image/webp", quality: 0.62 },
    // Time bounds normal pages; event count bounds mutation-heavy pages so a
    // seek checkpoint cannot grow without limit between periodic snapshots.
    checkoutEveryNth: CHECKOUT_EVERY_NTH,
    checkoutEveryNms: CHECKOUT_EVERY_MS,
    errorHandler(error: unknown) {
      onError?.(error);
      return true;
    },
  };
}

function mergeSelectors(base: string, extra: string | undefined): string {
  return extra === undefined ? base : `${base}, ${extra}`;
}

function isPreStartCustomEventError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("add custom event after start recording");
}

const RRWEB_META_EVENT_TYPE = 4;

/**
 * rrweb Meta events embed the full window.location.href (query + fragment)
 * into the recorded payload — the one place the SDK's URL scrubbing did not
 * reach. Scrub it here so R2 recordings honor allowUrlParams like every
 * metadata surface does. DOM-snapshot attributes (<a href>, <img src>) are
 * inherent to replay fidelity and intentionally untouched.
 */
export function scrubMetaHref(
  event: eventWithTime,
  allowUrlParams: readonly string[],
): eventWithTime {
  if (event.type !== RRWEB_META_EVENT_TYPE) {
    return event;
  }

  const data = event.data as { href?: unknown };
  if (typeof data?.href !== "string" || data.href.length === 0) {
    return event;
  }

  return { ...event, data: { ...event.data, href: scrubUrl(data.href, allowUrlParams) } };
}
