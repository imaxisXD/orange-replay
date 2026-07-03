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
      flushEvents(scope, buildBatch, events, message);
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

const WORKER_CORE_SOURCE = `
const encoder = new TextEncoder();

async function serializeAndCompressBatch(events) {
  const serialized = stringifyReplayEvents(events);
  const plainBytes = encoder.encode(serialized.json);

  if (typeof CompressionStream !== "function") {
    return {
      payload: plainBytes,
      uncompressed: true,
      droppedEventCount: serialized.droppedEventCount,
    };
  }

  try {
    const body = new Response(plainBytes).body;
    if (body === null) {
      return {
        payload: plainBytes,
        uncompressed: true,
        droppedEventCount: serialized.droppedEventCount,
      };
    }

    const compressed = await new Response(
      body.pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    return {
      payload: new Uint8Array(compressed),
      uncompressed: false,
      droppedEventCount: serialized.droppedEventCount,
    };
  } catch {
    return {
      payload: plainBytes,
      uncompressed: true,
      droppedEventCount: serialized.droppedEventCount,
    };
  }
}

function stringifyReplayEvents(events) {
  try {
    return { json: JSON.stringify(events), droppedEventCount: 0 };
  } catch {
    const keptEvents = [];
    let droppedEventCount = 0;

    for (const event of events) {
      try {
        JSON.stringify(event);
        keptEvents.push(event);
      } catch {
        droppedEventCount += 1;
      }
    }

    try {
      return {
        json: JSON.stringify(keptEvents),
        droppedEventCount,
      };
    } catch {
      return {
        json: "[]",
        droppedEventCount: events.length,
      };
    }
  }
}
`;

export function makeWorkerEntrySource(workerCoreSource = WORKER_CORE_SOURCE): string {
  return `
${workerCoreSource}

const events = [];

self.onmessage = (rawEvent) => {
  const message = rawEvent.data;

  if (message.type === "add") {
    events.push(...message.events);
    return;
  }

  if (message.type === "flush") {
    flushEvents(message);
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

function flushEvents(message) {
  const take = cleanTake(message.take, events.length);
  const batchEvents = events.splice(0, take);
  void serializeAndCompressBatch(batchEvents)
    .then((result) => {
      const buffer = toTransferBuffer(result.payload);
      self.postMessage(
        {
          type: "batch",
          id: message.id,
          payload: buffer,
          uncompressed: result.uncompressed,
          droppedEventCount: result.droppedEventCount,
        },
        [buffer],
      );
    })
    .catch((error) => {
      self.postMessage({
        type: "batch",
        id: message.id,
        error: stringFromUnknown(error) || "Orange Replay worker flush failed.",
      });
    });
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

function stringFromUnknown(value) {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  return "";
}
`;
}

const maybeWorkerScope = globalThis as unknown as WorkerScope & { document?: unknown };

if (maybeWorkerScope.document === undefined && typeof maybeWorkerScope.postMessage === "function") {
  installWorkerEntry(maybeWorkerScope);
}

function flushEvents(
  scope: WorkerScope,
  buildBatch: BuildBatch,
  events: eventWithTime[],
  message: FlushMessage,
): void {
  const take = cleanTake(message.take, events.length);
  const batchEvents = events.splice(0, take);
  void buildBatch(batchEvents)
    .then((result) => {
      const buffer = toTransferBuffer(result.payload);
      scope.postMessage(
        {
          type: "batch",
          id: message.id,
          payload: buffer,
          uncompressed: result.uncompressed,
          droppedEventCount: result.droppedEventCount,
        },
        [buffer],
      );
    })
    .catch((error) => {
      scope.postMessage(
        {
          type: "batch",
          id: message.id,
          error: stringFromUnknown(error) || "Orange Replay worker flush failed.",
        },
        [],
      );
    });
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

function stringFromUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  return "";
}
