import { decodeBatchBytes } from "./worker-core.ts";
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

type DecodeBatch = (payload: Uint8Array) => Promise<ReplayEvent[]>;

const WORKER_CORE_SOURCE = `
const textDecoder = new TextDecoder("utf-8", { fatal: true });

async function decodeBatchBytes(payload) {
  const plainBytes = await gunzipOrPlain(payload);
  const text = textDecoder.decode(plainBytes);
  const parsed = JSON.parse(text);

  if (!Array.isArray(parsed)) {
    throw new Error("Replay batch JSON must be an array.");
  }

  return parsed;
}

async function gunzipOrPlain(payload) {
  if (typeof DecompressionStream !== "function") {
    return payload;
  }

  try {
    const body = new Response(payload).body;
    if (body === null) {
      return payload;
    }

    const buffer = await new Response(
      body.pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    return payload;
  }
}
`;

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

  void decodeBatchBytes(new Uint8Array(message.payload))
    .then((events) => {
      self.postMessage({ type: "decoded", id: message.id, events });
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
  decodeBatch: DecodeBatch = decodeBatchBytes,
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
      .then((events) => {
        scope.postMessage({ type: "decoded", id: message.id, events });
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
