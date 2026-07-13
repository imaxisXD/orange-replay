import type { AnalyticsWarehouseRecord } from "./export-record.ts";
import type { AnalyticsPipelineAdapter } from "./exporter.ts";

export const ANALYTICS_PIPELINE_BYTES_PER_SECOND = 4_000_000;
const MAX_PIPELINE_REQUEST_BYTES = 5_000_000;
const encoder = new TextEncoder();

interface AnalyticsStreamSender {
  send(records: readonly Record<string, unknown>[]): Promise<void>;
}

interface RateLimitOptions {
  bytesPerSecond?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  beforeSend?: (requestBytes: number) => Promise<number | void>;
}

export function createRateLimitedAnalyticsPipeline(
  stream: AnalyticsStreamSender,
  options: RateLimitOptions = {},
): AnalyticsPipelineAdapter {
  const bytesPerSecond = options.bytesPerSecond ?? ANALYTICS_PIPELINE_BYTES_PER_SECOND;
  if (!Number.isSafeInteger(bytesPerSecond) || bytesPerSecond <= 0) {
    throw new Error("Analytics Pipeline rate must be a positive whole number.");
  }
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitForMilliseconds;
  const beforeSend = options.beforeSend;
  let nextSendAt = 0;

  return {
    async send(records: readonly AnalyticsWarehouseRecord[]): Promise<void> {
      const requestBytes = encoder.encode(JSON.stringify(records)).byteLength;
      if (requestBytes > MAX_PIPELINE_REQUEST_BYTES) {
        throw new Error("Analytics Pipeline request is larger than 5 MB.");
      }

      const currentTime = now();
      const reservedWait = await beforeSend?.(requestBytes);
      const waitMs =
        typeof reservedWait === "number"
          ? checkedWait(reservedWait)
          : Math.max(0, nextSendAt - currentTime);
      if (waitMs > 0) await wait(waitMs);

      if (reservedWait === undefined) {
        const sendTime = Math.max(nextSendAt, now());
        nextSendAt = sendTime + Math.ceil((requestBytes / bytesPerSecond) * 1_000);
      }
      await stream.send(records as unknown as readonly Record<string, unknown>[]);
    },
  };
}

function checkedWait(milliseconds: number): number {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error("Analytics Pipeline wait time is invalid.");
  }
  return milliseconds;
}

async function waitForMilliseconds(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
