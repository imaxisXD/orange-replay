import { WORKER_CORE_SOURCE } from "./decode-worker-source.ts";
import { decodeBatchWithStats, type DecodedReplayEvents } from "./worker-core.ts";
import type { ReplayEvent } from "./types.ts";

export interface DecodeRequestMessage {
  type: "decode";
  id: number;
  payload: ArrayBuffer;
}

export interface StopWorkerMessage {
  type: "stop";
}

export type DecodeWorkerRequest = DecodeRequestMessage | StopWorkerMessage;

export interface DecodeSuccessMessage {
  type: "decoded";
  id: number;
  events: ReplayEvent[];
  decodedBytes: number;
}

export interface DecodeErrorMessage {
  type: "decoded";
  id: number;
  error: string;
}

export type DecodeWorkerResponse = DecodeSuccessMessage | DecodeErrorMessage;

interface WorkerScope {
  onmessage: ((event: MessageEvent<DecodeWorkerRequest>) => void) | null;
  postMessage(message: DecodeWorkerResponse): void;
  close?: () => void;
}

type DecodeBatch = (payload: Uint8Array) => Promise<DecodedReplayEvents>;

export function makeDecodeWorkerSource(workerCoreSource = WORKER_CORE_SOURCE): string {
  return `
${workerCoreSource}

self.onmessage = (rawEvent) => {
  const message = rawEvent.data;

  if (message.type === "stop") {
    self.close();
    return;
  }

  if (message.type !== "decode") {
    return;
  }

  void decodeBatchWithStats(new Uint8Array(message.payload))
    .then((decoded) => {
      self.postMessage({
        type: "decoded",
        id: message.id,
        decodedBytes: decoded.decodedBytes,
        events: decoded.events,
      });
    })
    .catch((error) => {
      self.postMessage({
        type: "decoded",
        id: message.id,
        error: stringFromUnknown(error) || "Replay worker decode failed.",
      });
    });
};

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

export function installDecodeWorkerEntry(
  scope: WorkerScope,
  decodeBatch: DecodeBatch = decodeBatchWithStats,
): void {
  scope.onmessage = (rawEvent) => {
    const message = rawEvent.data;

    if (message.type === "stop") {
      scope.close?.();
      return;
    }

    if (message.type !== "decode") {
      return;
    }

    void decodeBatch(new Uint8Array(message.payload))
      .then((decoded) => {
        scope.postMessage({
          type: "decoded",
          id: message.id,
          decodedBytes: decoded.decodedBytes,
          events: decoded.events,
        });
      })
      .catch((error) => {
        scope.postMessage({
          type: "decoded",
          id: message.id,
          error: stringFromUnknown(error) || "Replay worker decode failed.",
        });
      });
  };
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

const maybeWorkerScope = globalThis as unknown as WorkerScope & { document?: unknown };

if (maybeWorkerScope.document === undefined && typeof maybeWorkerScope.postMessage === "function") {
  installDecodeWorkerEntry(maybeWorkerScope);
}
