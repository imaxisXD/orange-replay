import {
  EventType,
  IncrementalSource,
  type eventWithTime,
  type serializedNodeWithId,
  yieldForPaint,
} from "@orange-replay/rrweb-fork";
import { markSdkInternalError } from "../internal-error.ts";
import { SDK_BUFFER_CAP_BYTES } from "./backpressure.ts";
import type { WorkerBatchResult } from "./worker-core.ts";
import { makeWorkerEntrySource } from "./worker-entry.ts";

interface WorkerHostOptions {
  WorkerCtor?: typeof Worker;
  warn?: (message: string) => void;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  flushTimeoutMs?: number;
  window?: Window;
  now?: () => number;
  yieldToMain?: () => Promise<void>;
  onUnavailable?: () => void;
}

interface PendingFlush {
  resolve: (result: WorkerBatchResult) => void;
  reject: (error: unknown) => void;
  version: number;
  timeoutId: ReturnType<typeof setTimeout>;
}

type BatchMessage = readonly [
  type: "b",
  id: number,
  payload: ArrayBuffer | null,
  uncompressed: boolean | null,
  droppedEventCount?: number,
  error?: string,
];

interface FlushOptions {
  eventCount?: number;
}

export type WorkerEvent = readonly [event: eventWithTime, bytes: number];

const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;
const SNAPSHOT_CHUNK_NODES = 256;
const WORKER_MESSAGE_TARGET_BYTES = SDK_BUFFER_CAP_BYTES / 16;
const SNAPSHOT_TRANSFER_SLICE_MS = 4;

export class WorkerHost {
  private readonly warn?: (message: string) => void;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly flushTimeoutMs: number;
  private readonly now: () => number;
  private readonly yieldToMain: () => Promise<void>;
  private readonly onUnavailable?: () => void;
  private readonly pending = new Map<number, PendingFlush>();
  private worker: Worker | undefined;
  private objectUrl: string | undefined;
  private nextId = 1;
  private transferVersion = 0;
  private transferQueue = Promise.resolve();
  private unavailableReported = false;

  constructor(options: WorkerHostOptions = {}) {
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.revokeObjectUrl = options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL);
    this.flushTimeoutMs = cleanTimeoutMs(options.flushTimeoutMs);
    this.now = options.now ?? (() => options.window?.performance.now() ?? performance.now());
    this.yieldToMain = options.yieldToMain ?? (() => yieldForPaint(options.window));
    this.onUnavailable = options.onUnavailable;

    const WorkerCtor = options.WorkerCtor ?? safeWorkerCtor();
    const createObjectUrl = options.createObjectUrl ?? safeCreateObjectUrl();

    if (WorkerCtor === undefined || createObjectUrl === undefined) {
      this.useDegradedMode();
      return;
    }

    try {
      // CSP caveat: sites that block Blob workers use the fail-safe disabled path.
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

  addEvents(events: readonly WorkerEvent[]): void {
    if (events.length === 0) {
      return;
    }

    if (this.worker === undefined) return;

    const eventList = [...events];
    const version = this.transferVersion;
    this.transferQueue = this.transferQueue
      .then(() => this.sendEvents(eventList, version))
      .catch((error) => this.handleWorkerFailure(error));
  }

  isAvailable(): boolean {
    return this.worker !== undefined;
  }

  async flushBatch(options: FlushOptions = {}): Promise<WorkerBatchResult> {
    const version = this.transferVersion;
    await this.transferQueue;
    if (version !== this.transferVersion) {
      throw markSdkInternalError(new Error("Orange Replay worker reset before flush."));
    }
    const eventCount = cleanEventCount(options.eventCount);

    if (this.worker === undefined) {
      throw markSdkInternalError(new Error("Orange Replay worker is unavailable."));
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
        this.disableWorker();
        this.reportUnavailable(true);
        pending.reject(markSdkInternalError(new Error("Orange Replay worker timed out.")));
      }, this.flushTimeoutMs);
      this.pending.set(id, { resolve, reject, version, timeoutId });
    });

    this.worker.postMessage(["f", id, eventCount]);
    return result;
  }

  reset(): void {
    this.transferVersion += 1;
    this.transferQueue = Promise.resolve();
    this.rejectPending(new Error("Orange Replay worker reset before flush."));
    this.worker?.postMessage(["r"]);
  }

  stop(): void {
    this.transferVersion += 1;
    this.transferQueue = Promise.resolve();
    if (this.worker !== undefined) {
      this.worker.postMessage(["x"]);
      this.worker.terminate();
      this.worker = undefined;
    }

    this.rejectPending(new Error("Orange Replay worker stopped."));
    this.revokeWorkerUrl();
  }

  private useDegradedMode(): void {
    this.warn?.("or:disabled Worker blocked; recording stopped. Allow worker-src blob: in CSP.");
    this.reportUnavailable();
  }

  private async sendEvents(events: readonly WorkerEvent[], version: number): Promise<void> {
    if (this.worker === undefined || version !== this.transferVersion) return;
    let regularEvents: eventWithTime[] = [];
    let regularBytes = 0;
    let sliceStartedAt = this.now();
    const sendRegularEvents = async () => {
      if (
        regularEvents.length === 0 ||
        this.worker === undefined ||
        version !== this.transferVersion
      )
        return;
      this.worker.postMessage(["a", regularEvents]);
      regularEvents = [];
      regularBytes = 0;
      if (this.now() - sliceStartedAt >= SNAPSHOT_TRANSFER_SLICE_MS) {
        await this.yieldToMain();
        sliceStartedAt = this.now();
      }
    };

    for (const [event, knownBytes] of events) {
      let snapshotNode: serializedNodeWithId | undefined;
      let eventWithoutSnapshot: eventWithTime | undefined;
      if (event.type === EventType.FullSnapshot) {
        snapshotNode = event.data.node;
        eventWithoutSnapshot = {
          type: event.type,
          timestamp: event.timestamp,
          data: { node: null, initialOffset: event.data.initialOffset },
        } as unknown as eventWithTime;
      } else if (
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.Mutation &&
        event.data.isAttachIframe === true &&
        event.data.adds.length === 1
      ) {
        const { node, ...addWithoutNode } = event.data.adds[0]!;
        snapshotNode = node;
        eventWithoutSnapshot = {
          ...event,
          data: { ...event.data, adds: [{ ...addWithoutNode, node: null }] },
        } as unknown as eventWithTime;
      } else {
        const eventBytes = knownBytes > 0 ? knownBytes : 0;
        if (eventBytes > SDK_BUFFER_CAP_BYTES) {
          throw new Error("Orange Replay worker exceeded the 4 MB limit.");
        }
        if (
          regularEvents.length > 0 &&
          (regularBytes + eventBytes > WORKER_MESSAGE_TARGET_BYTES ||
            regularEvents.length >= SNAPSHOT_CHUNK_NODES)
        ) {
          await sendRegularEvents();
        }
        regularEvents.push(event);
        regularBytes += eventBytes;
        if (regularBytes >= WORKER_MESSAGE_TARGET_BYTES) await sendRegularEvents();
        continue;
      }

      await sendRegularEvents();
      await this.sendSnapshotTree(eventWithoutSnapshot!, snapshotNode!, version);
      sliceStartedAt = this.now();
    }
    await sendRegularEvents();
  }

  private async sendSnapshotTree(
    event: eventWithTime,
    root: serializedNodeWithId,
    version: number,
  ): Promise<void> {
    const worker = this.worker;
    if (worker === undefined || version !== this.transferVersion) return;

    let sliceStartedAt = this.now();
    const pendingNodes: serializedNodeWithId[] = [root];
    const pendingDepths: number[] = [0];
    // -1 is a node task. A non-negative value continues that node's children.
    const pendingChildIndexes: number[] = [-1];
    worker.postMessage(["s", event]);

    while (pendingNodes.length > 0) {
      if (version !== this.transferVersion || this.worker === undefined) return;
      const nodes: serializedNodeWithId[] = [];
      const depths: number[] = [];
      let messageBytes = 0;
      while (pendingNodes.length > 0 && nodes.length < SNAPSHOT_CHUNK_NODES) {
        const currentNode = pendingNodes.pop()!;
        const currentDepth = pendingDepths.pop()!;
        const childIndex = pendingChildIndexes.pop()!;
        const children = "childNodes" in currentNode ? currentNode.childNodes : [];
        if (childIndex >= 0) {
          const child = children[childIndex];
          if (child === undefined) continue;
          if (childIndex + 1 < children.length) {
            pendingNodes.push(currentNode);
            pendingDepths.push(currentDepth);
            pendingChildIndexes.push(childIndex + 1);
          }
          pendingNodes.push(child);
          pendingDepths.push(currentDepth + 1);
          pendingChildIndexes.push(-1);
          continue;
        }

        const nodeBytes = estimateNodeBytes(currentNode);
        if (nodeBytes > SDK_BUFFER_CAP_BYTES) {
          throw new Error("Orange Replay worker exceeded the 4 MB limit.");
        }
        if (nodes.length > 0 && messageBytes + nodeBytes > WORKER_MESSAGE_TARGET_BYTES) {
          pendingNodes.push(currentNode);
          pendingDepths.push(currentDepth);
          pendingChildIndexes.push(-1);
          break;
        }
        nodes.push(withoutSnapshotChildren(currentNode));
        depths.push(currentDepth);
        messageBytes += nodeBytes;
        if (children.length > 0) {
          pendingNodes.push(currentNode);
          pendingDepths.push(currentDepth);
          pendingChildIndexes.push(0);
        }
      }

      worker.postMessage(["n", nodes, depths]);
      const activeSliceMs = this.now() - sliceStartedAt;
      if (pendingNodes.length > 0 && activeSliceMs >= SNAPSHOT_TRANSFER_SLICE_MS) {
        await this.yieldToMain();
        sliceStartedAt = this.now();
      }
    }

    if (version !== this.transferVersion || this.worker === undefined) return;
    worker.postMessage(["e"]);
  }

  private handleWorkerMessage(message: BatchMessage): void {
    if (message[0] !== "b") {
      return;
    }

    const [, id, payload, uncompressed, droppedEventCount, error] = message;
    const pending = this.pending.get(id);
    if (pending === undefined || pending.version !== this.transferVersion) {
      return;
    }

    this.pending.delete(id);
    clearTimeout(pending.timeoutId);

    if (error !== undefined) {
      this.disableWorker();
      this.reportUnavailable(true);
      pending.reject(markSdkInternalError(new Error(error)));
      return;
    }

    if (payload === null || uncompressed === null) {
      this.disableWorker();
      this.reportUnavailable(true);
      pending.reject(markSdkInternalError(new Error("Orange Replay worker returned bad data.")));
      return;
    }

    const result = {
      payload: new Uint8Array(payload),
      uncompressed,
      droppedEventCount,
    };
    pending.resolve(result);
  }

  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(markSdkInternalError(error));
    }
    this.pending.clear();
  }

  private handleWorkerFailure(error: unknown): void {
    this.disableWorker();
    const pendingEntries = [...this.pending.values()];
    this.pending.clear();

    for (const pending of pendingEntries) {
      clearTimeout(pending.timeoutId);
      pending.reject(markSdkInternalError(error));
    }
    this.reportUnavailable(true);
  }

  private disableWorker(): void {
    if (this.worker !== undefined) {
      this.worker.terminate();
      this.worker = undefined;
    }

    this.revokeWorkerUrl();
  }

  private reportUnavailable(runtimeFailure = false): void {
    if (this.unavailableReported) return;
    this.unavailableReported = true;
    if (runtimeFailure) {
      this.warn?.("or:disabled Worker failed; recording stopped.");
    }
    this.onUnavailable?.();
  }

  private revokeWorkerUrl(): void {
    if (this.objectUrl === undefined) {
      return;
    }

    this.revokeObjectUrl(this.objectUrl);
    this.objectUrl = undefined;
  }
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

function withoutSnapshotChildren(node: serializedNodeWithId): serializedNodeWithId {
  if (!("childNodes" in node)) return node;
  return { ...node, childNodes: [] };
}

function estimateNodeBytes(node: serializedNodeWithId): number {
  let bytes = 64;
  if ("textContent" in node) bytes += node.textContent.length * 2;
  if ("name" in node) bytes += (node.name.length + node.publicId.length + node.systemId.length) * 2;
  if ("attributes" in node) {
    bytes += node.tagName.length * 2;
    for (const name in node.attributes) {
      const value = node.attributes[name];
      bytes += name.length * 2 + (typeof value === "string" ? value.length * 2 : 16);
    }
  }
  return bytes;
}
