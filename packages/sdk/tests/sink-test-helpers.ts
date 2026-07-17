import { vi } from "vite-plus/test";
import type { eventWithTime } from "@orange-replay/rrweb-fork";
import type { WorkerBatchResult } from "../src/pipeline/worker-core.ts";
import type { WorkerEvent, WorkerHost } from "../src/pipeline/worker-host.ts";
import { SessionManager, type StorageLike } from "../src/session.ts";
import { WorkerSink } from "../src/sink/worker-sink.ts";
import type { WorkerSinkOptions } from "../src/sink/contracts.ts";
import type { RecorderConfig } from "../src/types.ts";

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

export class MemoryCookieDocument implements Pick<Document, "cookie"> {
  private value = "";

  get cookie(): string {
    return this.value;
  }

  set cookie(value: string) {
    this.value = value.split(";", 1)[0] ?? "";
  }

  clear(): void {
    this.value = "";
  }
}

export const config: RecorderConfig = {
  key: "write-key",
  ingestUrl: "https://ingest.test",
  projectRef: "write-key",
  transport: "worker",
  sampleRate: 1,
  maskPolicyVersion: 0,
  capture: { heatmaps: false, console: false, network: false, canvas: false },
  allowUrlParams: [],
  flushMs: 15_000,
};

export function droppedEventCount(sink: WorkerSink): number {
  const counters = sink as unknown as {
    backpressure: { droppedCount(): number };
    indexEvents: { droppedCount(): number };
  };
  return counters.backpressure.droppedCount() + counters.indexEvents.droppedCount();
}

export function makeWorkerSink(
  options: Omit<WorkerSinkOptions, "onCheckpointRequested"> &
    Partial<Pick<WorkerSinkOptions, "onCheckpointRequested">>,
): WorkerSink {
  return new WorkerSink({ onCheckpointRequested: () => undefined, ...options });
}

export const decoder = new TextDecoder();

export function resetSinkTestState(): void {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "or_s=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax";
  window.sessionStorage.clear();
}

export async function gunzipToText(payload: Uint8Array): Promise<string> {
  const body = new Response(payload as unknown as BodyInit).body;
  if (body === null) {
    throw new Error("test gzip body missing");
  }

  const plain = await new Response(body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return decoder.decode(plain);
}

export function makeSession(
  ids: string[],
  cookieDocument?: Pick<Document, "cookie">,
): SessionManager {
  return new SessionManager({
    projectRef: "write-key",
    now: () => 1_000,
    storage: new MemoryStorage(),
    document: cookieDocument,
    cookieMode: cookieDocument === undefined ? "none" : "secure",
    makeId: () => ids.shift() ?? "extra-id",
  });
}

export function makeEvent(timestamp: number, name: string, value = ""): eventWithTime {
  return {
    type: 0,
    timestamp,
    data: { name, value },
  } as eventWithTime;
}

export function makeWorkerHost(): MockWorkerHost {
  return {
    addEvents: vi.fn(),
    flushBatch: vi.fn(async () => {
      throw new Error("worker flush should not run during pagehide");
    }),
    reset: vi.fn(),
    stop: vi.fn(),
  } as unknown as MockWorkerHost;
}

export function makeRetryWorkerHost(event: eventWithTime): MockWorkerHost {
  return {
    addEvents: vi.fn(),
    flushBatch: vi
      .fn()
      .mockRejectedValueOnce(new Error("worker failed"))
      .mockResolvedValueOnce({
        payload: new TextEncoder().encode(JSON.stringify([event])),
        uncompressed: true,
      } satisfies WorkerBatchResult),
    reset: vi.fn(),
    stop: vi.fn(),
  } as unknown as MockWorkerHost;
}

export function makeFailingWorkerHost(): MockWorkerHost {
  return {
    addEvents: vi.fn(),
    flushBatch: vi.fn().mockRejectedValue(new Error("worker failed")),
    reset: vi.fn(),
    stop: vi.fn(),
  } as unknown as MockWorkerHost;
}

export function makeResolvedWorkerHost(): MockWorkerHost {
  return {
    addEvents: vi.fn(),
    flushBatch: vi.fn(async () => {
      return {
        payload: new TextEncoder().encode(JSON.stringify([])),
        uncompressed: true,
      } satisfies WorkerBatchResult;
    }),
    reset: vi.fn(),
    stop: vi.fn(),
  } as unknown as MockWorkerHost;
}

export function makeCollectingWorkerHost(): MockWorkerHost {
  const events: eventWithTime[] = [];
  return {
    addEvents: vi.fn((nextEvents: WorkerEvent[]) => {
      events.push(...nextEvents.map(([event]) => event));
    }),
    flushBatch: vi.fn(async ({ eventCount }: { eventCount?: number } = {}) => {
      const take = eventCount ?? events.length;
      const batch = events.splice(0, take);
      return {
        payload: new TextEncoder().encode(JSON.stringify(batch)),
        uncompressed: true,
      } satisfies WorkerBatchResult;
    }),
    reset: vi.fn(() => {
      events.splice(0);
    }),
    stop: vi.fn(),
  } as unknown as MockWorkerHost;
}

export function makePendingWorkerHost(): {
  workerHost: MockWorkerHost;
  resolve: (result: WorkerBatchResult) => void;
  reject: (error: Error) => void;
} {
  let resolveFlush: (result: WorkerBatchResult) => void = () => undefined;
  let rejectFlush: (error: Error) => void = () => undefined;
  const flushPromise = new Promise<WorkerBatchResult>((resolve, reject) => {
    resolveFlush = resolve;
    rejectFlush = reject;
  });
  const workerHost = {
    addEvents: vi.fn(),
    flushBatch: vi.fn(() => flushPromise),
    reset: vi.fn(),
    stop: vi.fn(),
  } as unknown as MockWorkerHost;

  return { workerHost, resolve: resolveFlush, reject: rejectFlush };
}

export function installSendBeacon(
  send: (url: string, body?: BodyInit | null) => boolean,
): ReturnType<typeof vi.fn> {
  const sendBeacon = vi.fn(send);
  Object.defineProperty(window.navigator, "sendBeacon", {
    configurable: true,
    value: sendBeacon,
  });
  return sendBeacon;
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type MockWorkerHost = {
  addEvents: ReturnType<typeof vi.fn>;
  flushBatch: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} & WorkerHost;
