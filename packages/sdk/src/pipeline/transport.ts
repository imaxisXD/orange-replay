import {
  HDR_FLAGS,
  HDR_KEY,
  HDR_SEQ,
  HDR_SESSION,
  HDR_TAB,
  SDK_FLUSH_DEFAULT_MS,
} from "@orange-replay/shared/constants";
import type { BatchIndex, IngestAck } from "@orange-replay/shared/types";
import type { RecorderConfig } from "../types.ts";

export interface TransportBatch {
  body: Uint8Array;
  index: BatchIndex;
  flags: number;
  keepalive: boolean;
}

export interface TransportResult {
  sent: boolean;
  dropped: boolean;
  attempts: number;
  ack?: IngestAck;
}

export interface TransportOptions {
  config: RecorderConfig;
  fetch?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}

const BASE_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 10_000;

export class Transport {
  private readonly config: RecorderConfig;
  private readonly fetchFn: typeof fetch;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(options: TransportOptions) {
    this.config = options.config;
    this.fetchFn = options.fetch ?? fetch.bind(globalThis);
    this.wait = options.wait ?? defaultWait;
  }

  async sendBatch(batch: TransportBatch): Promise<TransportResult> {
    let attempts = 0;

    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await this.fetchFn(`${this.config.ingestUrl}/v1/ingest`, {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            [HDR_KEY]: this.config.key,
            [HDR_SESSION]: batch.index.s,
            [HDR_TAB]: batch.index.tab,
            [HDR_SEQ]: String(batch.index.seq),
            [HDR_FLAGS]: String(batch.flags),
          },
          body: batch.body as unknown as BodyInit,
          keepalive: batch.keepalive,
          signal: controller.signal,
        });

        if (response.status === 429 || response.status >= 500) {
          if (attempts >= MAX_ATTEMPTS) {
            return { sent: false, dropped: true, attempts };
          }
          await this.wait(retryDelayMs(attempts, response.headers.get("retry-after")));
          continue;
        }

        if (response.status >= 400) {
          return { sent: false, dropped: true, attempts };
        }

        const ack = await readAck(response);
        return { sent: true, dropped: false, attempts, ack };
      } catch {
        if (attempts >= MAX_ATTEMPTS) {
          return { sent: false, dropped: true, attempts };
        }

        await this.wait(retryDelayMs(attempts));
      } finally {
        clearTimeout(timeout);
      }
    }

    return { sent: false, dropped: true, attempts };
  }

  queueBatchSync(batch: TransportBatch, onFailure?: () => void, onSuccess?: () => void): boolean {
    try {
      const response = this.fetchFn(`${this.config.ingestUrl}/v1/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          [HDR_KEY]: this.config.key,
          [HDR_SESSION]: batch.index.s,
          [HDR_TAB]: batch.index.tab,
          [HDR_SEQ]: String(batch.index.seq),
          [HDR_FLAGS]: String(batch.flags),
        },
        body: batch.body as unknown as BodyInit,
        keepalive: true,
      });

      void response
        .then(async (result) => {
          if (!result.ok) {
            onFailure?.();
            return;
          }

          await readAck(result);
          onSuccess?.();
        })
        .catch(() => {
          onFailure?.();
        });
    } catch {
      return false;
    }

    return true;
  }
}

export async function readAck(response: Response): Promise<IngestAck> {
  try {
    const parsed = (await response.json()) as Partial<IngestAck>;
    return {
      ok: parsed.ok === true,
      live: parsed.live === true,
      flushMs:
        typeof parsed.flushMs === "number" && Number.isFinite(parsed.flushMs)
          ? parsed.flushMs
          : SDK_FLUSH_DEFAULT_MS,
      drop: parsed.drop === true,
      closed: parsed.closed === true,
      checkpoint: parsed.checkpoint === true,
    };
  } catch {
    return { ok: response.ok, live: false, flushMs: SDK_FLUSH_DEFAULT_MS };
  }
}

function retryDelayMs(attemptsAlreadyUsed: number, retryAfter: string | null = null): number {
  const backoff = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** (attemptsAlreadyUsed - 1));
  const requestedDelay = parseRetryAfterMs(retryAfter);
  return requestedDelay === null
    ? backoff
    : Math.min(MAX_RETRY_MS, Math.max(backoff, requestedDelay));
}

function parseRetryAfterMs(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
