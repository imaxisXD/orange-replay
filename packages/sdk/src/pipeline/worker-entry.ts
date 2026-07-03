import type { eventWithTime } from "@orange-replay/rrweb-fork";
import { serializeAndCompressBatch, type WorkerBatchResult } from "./worker-core.ts";

interface AddMessage {
  type: "add";
  events: eventWithTime[];
}

interface FlushMessage {
  type: "flush";
  id: number;
  take?: number;
}

interface StopMessage {
  type: "stop";
}

interface ResetMessage {
  type: "reset";
}

type WorkerMessage = AddMessage | FlushMessage | StopMessage | ResetMessage;

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  close?: () => void;
}

type BuildBatch = (events: readonly eventWithTime[]) => Promise<WorkerBatchResult>;

export function installWorkerEntry(
  scope: WorkerScope,
  buildBatch: BuildBatch = serializeAndCompressBatch,
): void {
  const events: eventWithTime[] = [];

  scope.onmessage = (rawEvent) => {
    const message = rawEvent.data;

    if (message.type === "add") {
      events.push(...message.events);
      return;
    }

    if (message.type === "flush") {
      void flushEvents(scope, buildBatch, events, message);
      return;
    }

    if (message.type === "reset") {
      events.splice(0);
      return;
    }

    if (message.type === "stop") {
      scope.close?.();
    }
  };
}

export function makeWorkerEntrySource(workerCoreUrl: string): string {
  return `
import { serializeAndCompressBatch } from ${JSON.stringify(workerCoreUrl)};

const events = [];

self.onmessage = (rawEvent) => {
  const message = rawEvent.data;

  if (message.type === "add") {
    events.push(...message.events);
    return;
  }

  if (message.type === "flush") {
    void flushEvents(message);
    return;
  }

  if (message.type === "reset") {
    events.splice(0);
    return;
  }

  if (message.type === "stop") {
    self.close();
  }
};

async function flushEvents(message) {
  const take = cleanTake(message.take, events.length);
  const batchEvents = events.splice(0, take);
  const result = await serializeAndCompressBatch(batchEvents);
  const buffer = toTransferBuffer(result.payload);
  self.postMessage(
    { type: "batch", id: message.id, payload: buffer, uncompressed: result.uncompressed },
    [buffer],
  );
}

function cleanTake(value, total) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return total;
  }

  return Math.min(total, Math.floor(value));
}

function toTransferBuffer(payload) {
  if (payload.byteOffset === 0 && payload.byteLength === payload.buffer.byteLength) {
    return payload.buffer;
  }

  return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
}
`;
}

const maybeWorkerScope = globalThis as unknown as WorkerScope & { document?: unknown };

if (maybeWorkerScope.document === undefined && typeof maybeWorkerScope.postMessage === "function") {
  installWorkerEntry(maybeWorkerScope);
}

async function flushEvents(
  scope: WorkerScope,
  buildBatch: BuildBatch,
  events: eventWithTime[],
  message: FlushMessage,
): Promise<void> {
  const take = cleanTake(message.take, events.length);
  const batchEvents = events.splice(0, take);
  const result = await buildBatch(batchEvents);
  const buffer = toTransferBuffer(result.payload);
  scope.postMessage(
    { type: "batch", id: message.id, payload: buffer, uncompressed: result.uncompressed },
    [buffer],
  );
}

function cleanTake(value: number | undefined, total: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return total;
  }

  return Math.min(total, Math.floor(value));
}

function toTransferBuffer(payload: Uint8Array): ArrayBuffer {
  if (
    payload.buffer instanceof ArrayBuffer &&
    payload.byteOffset === 0 &&
    payload.byteLength === payload.buffer.byteLength
  ) {
    return payload.buffer;
  }

  const copy = new Uint8Array(payload.byteLength);
  copy.set(payload);
  return copy.buffer;
}
