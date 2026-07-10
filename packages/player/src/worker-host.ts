import { decodeBatchWithStats, type DecodedReplayEvents } from "./worker-core.ts";
import { makeDecodeWorkerSource, type DecodeWorkerResponse } from "./worker-entry.ts";
import type { DecodeWorkerOptions, ReplayEvent } from "./types.ts";

interface PendingDecode {
  resolve: (decoded: DecodedReplayEvents) => void;
  reject: (error: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const DEFAULT_DECODE_TIMEOUT_MS = 15_000;
const MAX_WORKER_RESTARTS = 3;

export class DecodeWorkerHost {
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly createObjectUrl: ((blob: Blob) => string) | undefined;
  private readonly WorkerCtor: typeof Worker | undefined;
  private readonly timeoutMs: number;
  private readonly allowSynchronousFallback: boolean;
  private readonly pending = new Map<number, PendingDecode>();
  private worker: Worker | undefined;
  private objectUrl: string | undefined;
  private nextId = 1;
  private restartCount = 0;
  private terminalError: Error | undefined;
  private synchronousFallback = false;
  private stopped = false;

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

    this.WorkerCtor = WorkerCtor;
    this.createObjectUrl = createObjectUrl;

    try {
      this.startWorker();
    } catch {
      this.revokeWorkerUrl();
      this.useSynchronousFallback();
    }
  }

  isSynchronousFallback(): boolean {
    return this.synchronousFallback;
  }

  async decodeBatch(payload: Uint8Array): Promise<ReplayEvent[]> {
    return (await this.decodeBatchWithStats(payload)).events;
  }

  async decodeBatchWithStats(payload: Uint8Array): Promise<DecodedReplayEvents> {
    if (this.stopped) {
      throw new Error("Replay worker stopped.");
    }

    if (this.worker === undefined) {
      if (!this.synchronousFallback) {
        throw this.terminalError ?? new Error("Replay worker is not available.");
      }

      return decodeBatchWithStats(payload);
    }

    const id = this.nextId;
    this.nextId += 1;
    const buffer = exactArrayBuffer(payload);

    const result = new Promise<DecodedReplayEvents>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending === undefined) {
          return;
        }

        this.restartWorkerAfterFailure("Replay worker timed out. Pending decodes were canceled.");
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timeoutId });
    });

    try {
      this.worker.postMessage({ type: "decode", id, payload: buffer }, [buffer]);
    } catch (error) {
      this.restartWorkerAfterFailure("Replay worker failed. Pending decodes were canceled.", error);
    }
    return result;
  }

  stop(): void {
    this.stopped = true;
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
    this.restartCount = 0;

    if ("error" in message) {
      pending.reject(new Error(message.error));
      return;
    }

    pending.resolve({ decodedBytes: message.decodedBytes, events: message.events });
  }

  private handleWorkerFailure(error: unknown): void {
    this.restartWorkerAfterFailure("Replay worker failed. Pending decodes were canceled.", error);
  }

  private restartWorkerAfterFailure(message: string, cause?: unknown): void {
    if (this.restartCount >= MAX_WORKER_RESTARTS) {
      const terminalError = new Error("Replay worker failed too many times.");
      this.rejectAllPending(terminalError);
      this.closeWorker();
      this.terminalError = terminalError;
      return;
    }

    this.rejectAllPending(makeWorkerError(message, cause));
    this.closeWorker();

    this.restartCount += 1;
    try {
      this.startWorker();
    } catch {
      this.closeWorker();
      this.terminalError = new Error("Replay worker could not restart.");
    }
  }

  private startWorker(): void {
    if (this.WorkerCtor === undefined || this.createObjectUrl === undefined) {
      throw new Error("Replay worker cannot start in this browser.");
    }

    const source = makeDecodeWorkerSource();
    const blob = new Blob([source], { type: "text/javascript" });
    this.objectUrl = this.createObjectUrl(blob);
    this.worker = new this.WorkerCtor(this.objectUrl, {
      name: "orange-replay-player-decode",
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<DecodeWorkerResponse>) => {
      this.handleWorkerMessage(event.data);
    };
    this.worker.onerror = (event) => {
      this.handleWorkerFailure(event.error ?? new Error("Replay worker failed."));
    };
    this.terminalError = undefined;
  }

  private closeWorker(): void {
    if (this.worker !== undefined) {
      this.worker.terminate();
      this.worker = undefined;
    }

    this.revokeWorkerUrl();
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

  private rejectAllPending(error: unknown): void {
    const pendingEntries = [...this.pending.values()];
    this.pending.clear();

    for (const pending of pendingEntries) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function makeWorkerError(message: string, cause: unknown): Error {
  const error = new Error(message);
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
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
