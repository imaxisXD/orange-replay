import type { eventWithTime } from "@orange-replay/rrweb-fork";
import { serializeAndCompressBatch, type WorkerBatchResult } from "./worker-core.ts";
import { makeWorkerEntrySource } from "./worker-entry.ts";

interface WorkerHostOptions {
  WorkerCtor?: typeof Worker;
  warn?: (message: string) => void;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

interface PendingFlush {
  resolve: (result: WorkerBatchResult) => void;
  reject: (error: unknown) => void;
}

interface BatchMessage {
  type: "batch";
  id: number;
  payload: ArrayBuffer;
  uncompressed: boolean;
}

interface FlushOptions {
  eventCount?: number;
}

let warnedAboutDegradedMode = false;

export class WorkerHost {
  private readonly warn?: (message: string) => void;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly pending = new Map<number, PendingFlush>();
  private readonly inlineEvents: eventWithTime[] = [];
  private worker: Worker | undefined;
  private objectUrl: string | undefined;
  private nextId = 1;
  private degraded = false;

  constructor(options: WorkerHostOptions = {}) {
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.revokeObjectUrl = options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL);

    const WorkerCtor = options.WorkerCtor ?? safeWorkerCtor();
    const createObjectUrl = options.createObjectUrl ?? safeCreateObjectUrl();

    if (WorkerCtor === undefined || createObjectUrl === undefined) {
      this.useDegradedMode();
      return;
    }

    try {
      // CSP caveat: sites that block blob workers through worker-src use the degraded path.
      const workerCoreUrl = new URL("./worker-core.ts", import.meta.url).href;
      const workerSource = makeWorkerEntrySource(workerCoreUrl);
      const blob = new Blob([workerSource], { type: "text/javascript" });
      this.objectUrl = createObjectUrl(blob);
      this.worker = new WorkerCtor(this.objectUrl, {
        name: "orange-replay-pipeline",
        type: "module",
      });
      this.worker.onmessage = (event: MessageEvent<BatchMessage>) => {
        this.handleWorkerMessage(event.data);
      };
      this.worker.onerror = (event) => {
        this.rejectPending(event.error ?? new Error("Orange Replay worker failed."));
      };
    } catch {
      this.useDegradedMode();
    }
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  addEvents(events: readonly eventWithTime[]): void {
    if (events.length === 0) {
      return;
    }

    if (this.worker === undefined) {
      this.inlineEvents.push(...events);
      return;
    }

    const eventList = [...events];
    this.worker.postMessage({ type: "add", events: eventList }, findTransferables(eventList));
  }

  async flushBatch(options: FlushOptions = {}): Promise<WorkerBatchResult> {
    const eventCount = cleanEventCount(options.eventCount);

    if (this.worker === undefined) {
      const take = eventCount ?? this.inlineEvents.length;
      const events = this.inlineEvents.splice(0, take);
      return serializeAndCompressBatch(events);
    }

    const id = this.nextId;
    this.nextId += 1;

    const result = new Promise<WorkerBatchResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.worker.postMessage({ type: "flush", id, take: eventCount });
    return result;
  }

  reset(): void {
    this.inlineEvents.splice(0);
    this.worker?.postMessage({ type: "reset" });
  }

  stop(): void {
    if (this.worker !== undefined) {
      this.worker.postMessage({ type: "stop" });
      this.worker.terminate();
      this.worker = undefined;
    }

    this.rejectPending(new Error("Orange Replay worker stopped."));
    this.inlineEvents.splice(0);

    if (this.objectUrl !== undefined) {
      this.revokeObjectUrl(this.objectUrl);
      this.objectUrl = undefined;
    }
  }

  private useDegradedMode(): void {
    this.degraded = true;
    warnDegraded(this.warn);
  }

  private handleWorkerMessage(message: BatchMessage): void {
    if (message.type !== "batch") {
      return;
    }

    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }

    this.pending.delete(message.id);
    pending.resolve({
      payload: new Uint8Array(message.payload),
      uncompressed: message.uncompressed,
    });
  }

  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function findTransferables(value: unknown): Transferable[] {
  const transfers: Transferable[] = [];
  const buffers = new Set<ArrayBuffer>();
  const seen = new WeakSet<object>();

  walkTransferables(value, transfers, buffers, seen, 0);
  return transfers;
}

function walkTransferables(
  value: unknown,
  transfers: Transferable[],
  buffers: Set<ArrayBuffer>,
  seen: WeakSet<object>,
  depth: number,
): void {
  if (value === null || typeof value !== "object" || depth > 8) {
    return;
  }

  if (seen.has(value)) {
    return;
  }

  seen.add(value);

  if (value instanceof ArrayBuffer) {
    addBuffer(value, transfers, buffers);
    return;
  }

  if (ArrayBuffer.isView(value)) {
    const buffer = value.buffer;
    if (buffer instanceof ArrayBuffer) {
      addBuffer(buffer, transfers, buffers);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkTransferables(item, transfers, buffers, seen, depth + 1);
    }
    return;
  }

  for (const item of Object.values(value)) {
    walkTransferables(item, transfers, buffers, seen, depth + 1);
  }
}

function addBuffer(
  buffer: ArrayBuffer,
  transfers: Transferable[],
  buffers: Set<ArrayBuffer>,
): void {
  if (buffer.byteLength === 0 || buffers.has(buffer)) {
    return;
  }

  buffers.add(buffer);
  transfers.push(buffer);
}

function warnDegraded(warn: ((message: string) => void) | undefined): void {
  if (warnedAboutDegradedMode) {
    return;
  }

  warnedAboutDegradedMode = true;
  warn?.(
    "or:degraded Worker creation failed; Orange Replay is running serialization and gzip on the main thread. If your CSP blocks blob workers, allow worker-src blob: or configure the inline transport.",
  );
}

function safeWorkerCtor(): typeof Worker | undefined {
  return typeof Worker === "undefined" ? undefined : Worker;
}

function safeCreateObjectUrl(): ((blob: Blob) => string) | undefined {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return undefined;
  }

  return URL.createObjectURL.bind(URL);
}

function cleanEventCount(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.floor(value);
}
