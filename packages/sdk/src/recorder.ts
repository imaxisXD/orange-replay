import {
  addCustomEvent as addRrwebCustomEvent,
  record,
  type eventWithTime,
  type recordOptions,
} from "@orange-replay/rrweb-fork";
import type { Sink } from "./sink.ts";
import type { RecorderConfig } from "./types.ts";

const DEFAULT_BLOCK_SELECTOR = "[data-orange-block]";
const DEFAULT_IGNORE_SELECTOR = "[data-orange-ignore]";
const CHECKOUT_EVERY_MS = 4 * 60 * 1000;

export interface RecorderOptions {
  config: RecorderConfig;
  sink: Sink;
}

export class Recorder {
  private readonly config: RecorderConfig;
  private readonly sink: Sink;
  private stopRecord?: () => void;
  private disabled = false;
  private warned = false;

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
      }
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

    try {
      addRrwebCustomEvent(name, payload);
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
      this.sink.addRrwebEvent(event);
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
