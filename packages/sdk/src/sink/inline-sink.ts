import type { eventWithTime } from "@orange-replay/rrweb-fork";
import { serializeAndCompressBatch, type WorkerBatchResult } from "../pipeline/worker-core.ts";
import type { WorkerEvent, WorkerHost } from "../pipeline/worker-host.ts";
import type { InlineSinkOptions } from "./contracts.ts";
import { WorkerSink } from "./worker-sink.ts";

/**
 * Keeps the explicit no-worker option on the same tested batching, page-close,
 * retry, and session path as the normal recorder.
 */
export class InlineSink extends WorkerSink {
  public constructor(options: InlineSinkOptions) {
    super({
      ...options,
      workerHost: new InlineEventSerializer() as unknown as WorkerHost,
    });
  }
}

class InlineEventSerializer {
  private readonly capturedEvents: eventWithTime[] = [];

  public addEvents(events: readonly WorkerEvent[]): void {
    for (const [event] of events) this.capturedEvents.push(event);
  }

  public async flushBatch(options: { eventCount?: number } = {}): Promise<WorkerBatchResult> {
    const requested = options.eventCount ?? this.capturedEvents.length;
    const eventCount = Math.max(0, Math.min(this.capturedEvents.length, Math.floor(requested)));
    const events = this.capturedEvents.splice(0, eventCount);
    return serializeAndCompressBatch(events, false, false);
  }

  public reset(): void {
    this.capturedEvents.splice(0);
  }

  public stop(): void {
    this.reset();
  }
}
