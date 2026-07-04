import { decodeBatchBytes } from "./worker-core.ts";
import { makeDecodeWorkerSource, type DecodeWorkerResponse } from "./worker-entry.ts";
import type { DecodeWorkerOptions, ReplayEvent } from "./types.ts";

interface PendingDecode {
  resolve: (events: ReplayEvent[]) => void;
  reject: (error: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const DEFAULT_DECODE_TIMEOUT_MS = 15_000;

export class DecodeWorkerHost {
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly timeoutMs: number;
  private readonly allowSynchronousFallback: boolean;
  private readonly pending = new Map<number, PendingDecode>();
  private worker: Worker | undefined;
  private objectUrl: string | undefined;
  private nextId = 1;
  private synchronousFallback = false;

  constructor(options: DecodeWorkerOptions = {}) {
    this.revokeObjectUrl = options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL);
    this.timeoutMs = cleanTimeoutMs(options.timeoutMs);
    this.allowSynchronousFallback = options.allowSynchronousFallback === true;

    const WorkerCtor = options.WorkerCtor ?? safeWorkerCtor();
    const createObjectUrl = options.createObjectUrl ?? safeCreateObjectUrl();

    if (WorkerCtor === undefined || createObjectUrl === undefined) {
      this.useSynchronousFallback();
      return;
    }

    try {
      const source = makeDecodeWorkerSource();
      const blob = new Blob([source], { type: "text/javascript" });
      this.objectUrl = createObjectUrl(blob);
      this.worker = new WorkerCtor(this.objectUrl, {
        name: "orange-replay-player-decode",
        type: "module",
      });
      this.worker.onmessage = (event: MessageEvent<DecodeWorkerResponse>) => {
        this.handleWorkerMessage(event.data);
      };
      this.worker.onerror = (event) => {
        this.handleWorkerFailure(event.error ?? new Error("Replay worker failed."));
      };
    } catch {
      this.revokeWorkerUrl();
      this.useSynchronousFallback();
    }
  }

  isSynchronousFallback(): boolean {
    return this.synchronousFallback;
  }

  async decodeBatch(payload: Uint8Array): Promise<ReplayEvent[]> {
    if (this.worker === undefined) {
      if (!this.synchronousFallback) {
        throw new Error("Replay worker is not available.");
      }

      return decodeBatchBytes(payload);
    }

    const id = this.nextId;
    this.nextId += 1;
    const buffer = exactArrayBuffer(payload);

    const result = new Promise<ReplayEvent[]>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending === undefined) {
          return;
        }

        this.pending.delete(id);
        this.moveToFallback();
        pending.reject(new Error("Replay worker decode timed out."));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timeoutId });
    });

    this.worker.postMessage({ type: "decode", id, payload: buffer }, [buffer]);
    return result;
  }

  stop(): void {
    if (this.worker !== undefined) {
      this.worker.postMessage({ type: "stop" });
      this.worker.terminate();
      this.worker = undefined;
    }

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Replay worker stopped."));
    }
    this.pending.clear();
    this.revokeWorkerUrl();
  }

  private handleWorkerMessage(message: DecodeWorkerResponse): void {
    if (message.type !== "decoded") {
      return;
    }

    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timeoutId);

    if ("error" in message) {
      pending.reject(new Error(message.error));
      return;
    }

    pending.resolve(message.events);
  }

  private handleWorkerFailure(error: unknown): void {
    const pendingEntries = [...this.pending.values()];
    this.pending.clear();
    this.moveToFallback();

    for (const pending of pendingEntries) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
  }

  private moveToFallback(): void {
    if (this.worker !== undefined) {
      this.worker.terminate();
      this.worker = undefined;
    }

    this.revokeWorkerUrl();
    this.useSynchronousFallback();
  }

  private useSynchronousFallback(): void {
    if (!this.allowSynchronousFallback) {
      this.synchronousFallback = false;
      return;
    }

    this.synchronousFallback = true;
  }

  private revokeWorkerUrl(): void {
    if (this.objectUrl === undefined) {
      return;
    }

    this.revokeObjectUrl(this.objectUrl);
    this.objectUrl = undefined;
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
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

function cleanTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_DECODE_TIMEOUT_MS;
  }

  return Math.floor(value);
}
