import type { eventWithTime } from "@orange-replay/rrweb-fork";
import { markSdkInternalError } from "../internal-error.ts";
import { serializeAndCompressBatch, type WorkerBatchResult } from "./worker-core.ts";
import { makeWorkerEntrySource } from "./worker-entry.ts";

interface WorkerHostOptions {
  WorkerCtor?: typeof Worker;
  warn?: (message: string) => void;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  flushTimeoutMs?: number;
}

interface PendingFlush {
  resolve: (result: WorkerBatchResult) => void;
  reject: (error: unknown) => void;
  eventCount?: number;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface BatchMessage {
  type: "batch";
  id: number;
  payload?: ArrayBuffer;
  uncompressed?: boolean;
  droppedEventCount?: number;
  error?: string;
}

interface FlushOptions {
  eventCount?: number;
}

let warnedAboutDegradedMode = false;
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;

export class WorkerHost {
  private readonly warn?: (message: string) => void;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly flushTimeoutMs: number;
  private readonly pending = new Map<number, PendingFlush>();
  private readonly inlineEvents: eventWithTime[] = [];
  private worker: Worker | undefined;
  private objectUrl: string | undefined;
  private nextId = 1;
  private degraded = false;

  constructor(options: WorkerHostOptions = {}) {
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.revokeObjectUrl = options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL);
    this.flushTimeoutMs = cleanTimeoutMs(options.flushTimeoutMs);

    const WorkerCtor = options.WorkerCtor ?? safeWorkerCtor();
    const createObjectUrl = options.createObjectUrl ?? safeCreateObjectUrl();

    if (WorkerCtor === undefined || createObjectUrl === undefined) {
      this.useDegradedMode();
      return;
    }

    try {
      // CSP caveat: sites that block blob workers through worker-src use the degraded path.
      const workerSource = makeWorkerEntrySource();
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
        this.handleWorkerFailure(event.error ?? new Error("Orange Replay worker failed."));
      };
    } catch {
      this.revokeWorkerUrl();
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
    this.inlineEvents.push(...eventList);
    this.worker.postMessage({ type: "add", events: eventList });
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
      const timeoutId = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending === undefined) {
          return;
        }

        this.pending.delete(id);
        this.moveToInlineMode();
        pending.reject(markSdkInternalError(new Error("Orange Replay worker flush timed out.")));
      }, this.flushTimeoutMs);
      this.pending.set(id, { resolve, reject, eventCount, timeoutId });
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

    this.revokeWorkerUrl();
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
    clearTimeout(pending.timeoutId);

    if (message.error !== undefined) {
      this.moveToInlineMode();
      pending.reject(markSdkInternalError(new Error(message.error)));
      return;
    }

    if (message.payload === undefined || message.uncompressed === undefined) {
      this.moveToInlineMode();
      pending.reject(
        markSdkInternalError(new Error("Orange Replay worker returned an invalid batch.")),
      );
      return;
    }

    const take = pending.eventCount ?? this.inlineEvents.length;
    this.inlineEvents.splice(0, take);
    pending.resolve({
      payload: new Uint8Array(message.payload),
      uncompressed: message.uncompressed,
      droppedEventCount: message.droppedEventCount,
    });
  }

  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(markSdkInternalError(error));
    }
    this.pending.clear();
  }

  private handleWorkerFailure(error: unknown): void {
    this.moveToInlineMode();
    const pendingEntries = [...this.pending.values()];
    this.pending.clear();

    for (const pending of pendingEntries) {
      clearTimeout(pending.timeoutId);
      this.flushInlineEvents(pending.eventCount).then(pending.resolve, (inlineError) => {
        pending.reject(markSdkInternalError(inlineError ?? error));
      });
    }
  }

  private async flushInlineEvents(eventCount: number | undefined): Promise<WorkerBatchResult> {
    const take = eventCount ?? this.inlineEvents.length;
    const events = this.inlineEvents.splice(0, take);
    return serializeAndCompressBatch(events);
  }

  private moveToInlineMode(): void {
    if (this.worker !== undefined) {
      this.worker.terminate();
      this.worker = undefined;
    }

    this.revokeWorkerUrl();
    this.useDegradedMode();
  }

  private revokeWorkerUrl(): void {
    if (this.objectUrl === undefined) {
      return;
    }

    this.revokeObjectUrl(this.objectUrl);
    this.objectUrl = undefined;
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

function cleanTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_FLUSH_TIMEOUT_MS;
  }

  return Math.floor(value);
}
