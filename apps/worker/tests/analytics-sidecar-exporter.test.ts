import { describe, expect, it } from "vite-plus/test";
import type { AnalyticsWarehouseRecord } from "../src/analytics/export-record.ts";
import {
  drainAnalyticsExports,
  type AnalyticsPipelineAdapter,
  type AnalyticsSidecarReader,
} from "../src/analytics/exporter.ts";
import type {
  AnalyticsOutboxRow,
  AnalyticsOutboxStore,
  AnalyticsWarehouseState,
  SaveWarehouseStateInput,
} from "../src/analytics/outbox.ts";

const encoder = new TextEncoder();
const FIVE_MB = 5_000_000;

describe("complete analytics sidecar delivery", () => {
  it("streams valid events before the final coverage marker", async () => {
    const store = new OneRowStore(completeSessionRow(2));
    const accepted: AnalyticsWarehouseRecord[][] = [];
    const pipeline = collectingPipeline(accepted);
    const reader = fixedSidecarReader(
      byteChunks(
        [
          JSON.stringify({ v: 1, coverage: "complete" }),
          JSON.stringify({
            event_index: 0,
            event_time: 110,
            event_kind: "click",
            event_detail: "button#buy",
            event_meta: { x: 0.5, label: "buy" },
          }),
          JSON.stringify({
            event_index: 1,
            event_time: 120,
            event_kind: "error",
            event_detail: "Checkout failed",
          }),
        ].join("\n") + "\n",
        7,
      ),
    );

    await expect(
      drainAnalyticsExports(store, pipeline, { now: 500, sidecarReader: reader }),
    ).resolves.toEqual({ selected: 1, sent: 1, failed: 0, firstSequence: 7, lastSequence: 7 });

    expect(accepted).toHaveLength(3);
    expect(accepted[0]?.[0]).toMatchObject({
      record_kind: "session",
      export_id: "session:project:session",
      event_coverage: "complete",
    });
    expect(accepted[1]).toEqual([
      expect.objectContaining({
        record_kind: "event",
        export_id: "event:project:session:0:110:click",
        export_sequence: 7,
        event_index: 0,
        event_kind: "click",
        event_meta_json: '{"x":0.5,"label":"buy"}',
      }),
      expect.objectContaining({
        record_kind: "event",
        export_id: "event:project:session:1:120:error",
        export_sequence: 7,
        event_index: 1,
        event_kind: "error",
        event_meta_json: null,
      }),
    ]);
    expect(accepted[2]?.[0]).toMatchObject({
      record_kind: "event",
      export_id: "session:project:session",
      export_sequence: 7,
      event_index: 2,
      event_kind: "coverage_complete",
    });
    expect(store.row.sentAt).toBe(500);
    expect(store.row.lastError).toBeNull();
  });

  it("keeps the outbox row pending when the sidecar is missing, invalid, short, or extra", async () => {
    const cases: Array<{
      name: string;
      eventCount: number;
      reader: AnalyticsSidecarReader;
      error: string;
    }> = [
      {
        name: "missing",
        eventCount: 1,
        reader: {
          async get() {
            return null;
          },
        },
        error: "is missing its analytics sidecar",
      },
      {
        name: "invalid event kind",
        eventCount: 1,
        reader: lineSidecarReader([
          { v: 1, coverage: "complete" },
          { event_index: 0, event_time: 110, event_kind: "made_up" },
        ]),
        error: "invalid fields in sidecar event 0",
      },
      {
        name: "invalid metadata",
        eventCount: 1,
        reader: lineSidecarReader([
          { v: 1, coverage: "complete" },
          { event_index: 0, event_time: 110, event_kind: "click", event_meta: { nested: {} } },
        ]),
        error: "invalid metadata in sidecar event 0",
      },
      {
        name: "short",
        eventCount: 2,
        reader: lineSidecarReader([
          { v: 1, coverage: "complete" },
          { event_index: 0, event_time: 110, event_kind: "click" },
        ]),
        error: "sidecar has 1 events; expected 2",
      },
      {
        name: "extra",
        eventCount: 1,
        reader: lineSidecarReader([
          { v: 1, coverage: "complete" },
          { event_index: 0, event_time: 110, event_kind: "click" },
          { event_index: 1, event_time: 120, event_kind: "error" },
        ]),
        error: "sidecar has more than 1 events",
      },
      {
        name: "record over 32 KiB",
        eventCount: 1,
        reader: lineSidecarReader([
          { v: 1, coverage: "complete" },
          {
            event_index: 0,
            event_time: 110,
            event_kind: "click",
            event_detail: "x".repeat(33 * 1024),
          },
        ]),
        error: "sidecar line is larger than 32 KiB",
      },
    ];

    for (const testCase of cases) {
      const store = new OneRowStore(completeSessionRow(testCase.eventCount));
      const accepted: AnalyticsWarehouseRecord[][] = [];

      const result = await drainAnalyticsExports(store, collectingPipeline(accepted), {
        sidecarReader: testCase.reader,
      });

      expect(result, testCase.name).toMatchObject({ selected: 1, sent: 0, failed: 1 });
      expect(store.row, testCase.name).toMatchObject({
        sentAt: null,
        attemptCount: 1,
      });
      expect(store.row.lastError, testCase.name).toContain(testCase.error);
      expect(
        accepted
          .flat()
          .some(
            (record) =>
              record.record_kind === "event" &&
              "event_kind" in record &&
              record.event_kind === "coverage_complete",
          ),
        testCase.name,
      ).toBe(false);
    }
  });

  it("still throws when Pipeline delivery or R2 reading fails", async () => {
    const pipelineStore = new OneRowStore(completeSessionRow(1));
    await expect(
      drainAnalyticsExports(
        pipelineStore,
        {
          async send() {
            throw new Error("Pipeline is unavailable");
          },
        },
        {
          sidecarReader: lineSidecarReader([
            { v: 1, coverage: "complete" },
            { event_index: 0, event_time: 110, event_kind: "click" },
          ]),
        },
      ),
    ).rejects.toThrow("analytics export delivery failed: Pipeline is unavailable");
    expect(pipelineStore.row.lastError).toBe("Pipeline is unavailable");

    const readStore = new OneRowStore(completeSessionRow(1));
    await expect(
      drainAnalyticsExports(readStore, collectingPipeline([]), {
        sidecarReader: {
          async get() {
            throw new Error("R2 is unavailable");
          },
        },
      }),
    ).rejects.toThrow("could not read its analytics sidecar: R2 is unavailable");
    expect(readStore.row.lastError).toContain("R2 is unavailable");
  });

  it("stops a sidecar stream that never returns data", async () => {
    const store = new OneRowStore(completeSessionRow(1));
    const hangingBody = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
    });

    await expect(
      drainAnalyticsExports(store, collectingPipeline([]), {
        sidecarReadTimeoutMs: 5,
        sidecarReader: fixedSidecarReader(hangingBody),
      }),
    ).rejects.toThrow("analytics sidecar stream read timed out after 5 milliseconds");
    expect(store.row.sentAt).toBeNull();
    expect(store.row.lastError).toContain("timed out");
  });

  it("resumes accepted sidecar events after a crash before the sent status", async () => {
    const store = new OneRowStore(completeSessionRow(1));
    const accepted: AnalyticsWarehouseRecord[][] = [];
    const pipeline = collectingPipeline(accepted);
    const reader = lineSidecarReader([
      { v: 1, coverage: "complete" },
      { event_index: 0, event_time: 110, event_kind: "custom", event_detail: "checkout" },
    ]);
    store.failNextMarkSent = true;

    await expect(
      drainAnalyticsExports(store, pipeline, { now: 10, sidecarReader: reader }),
    ).rejects.toThrow("state write stopped");
    await expect(
      drainAnalyticsExports(store, pipeline, { now: 20, sidecarReader: reader }),
    ).resolves.toMatchObject({ sent: 1 });

    expect(accepted).toHaveLength(5);
    expect(
      accepted
        .flat()
        .filter(
          (record) =>
            record.record_kind === "event" &&
            "event_kind" in record &&
            record.event_kind === "custom",
        ),
    ).toHaveLength(1);
    expect(accepted[0]).toEqual(accepted[3]);
    expect(accepted[2]).toEqual(accepted[4]);
    expect(store.row.sidecarEventOffset).toBe(1);
    expect(store.row.sentAt).toBe(20);
  });

  it("retries a stable event batch when its progress write stops", async () => {
    const store = new OneRowStore(completeSessionRow(1));
    const accepted: AnalyticsWarehouseRecord[][] = [];
    const pipeline = collectingPipeline(accepted);
    const reader = lineSidecarReader([
      { v: 1, coverage: "complete" },
      { event_index: 0, event_time: 110, event_kind: "click" },
    ]);
    store.failNextSaveProgress = true;

    await expect(
      drainAnalyticsExports(store, pipeline, { now: 10, sidecarReader: reader }),
    ).rejects.toThrow("could not save sidecar progress: progress write stopped");
    expect(store.row.quarantinedAt).toBeNull();
    expect(store.row.sidecarEventOffset).toBe(0);

    await expect(
      drainAnalyticsExports(store, pipeline, { now: 20, sidecarReader: reader }),
    ).resolves.toMatchObject({ sent: 1 });
    const clickRecords = accepted
      .flat()
      .filter(
        (record) =>
          record.record_kind === "event" && "event_kind" in record && record.event_kind === "click",
      );
    expect(clickRecords).toHaveLength(2);
    expect(clickRecords[0]).toEqual(clickRecords[1]);
  });

  it("keeps every Pipeline request below 5 MB", async () => {
    const eventCount = 1_600;
    const store = new OneRowStore(completeSessionRow(eventCount));
    const accepted: AnalyticsWarehouseRecord[][] = [];
    const largeMeta = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`field_${String(index)}`, "m".repeat(200)]),
    );
    const reader = fixedSidecarReader(
      streamFromLines(
        (function* () {
          yield JSON.stringify({ v: 1, coverage: "complete" });
          for (let index = 0; index < eventCount; index += 1) {
            yield JSON.stringify({
              event_index: index,
              event_time: 1_000 + index,
              event_kind: "custom",
              event_detail: "d".repeat(200),
              event_meta: largeMeta,
            });
          }
        })(),
      ),
    );

    await drainAnalyticsExports(store, collectingPipeline(accepted), { sidecarReader: reader });

    const eventBatches = accepted.filter((records) =>
      records.some(
        (record) =>
          record.record_kind === "event" &&
          "event_kind" in record &&
          record.event_kind !== "coverage_complete",
      ),
    );
    expect(eventBatches.length).toBeGreaterThan(1);
    expect(eventBatches.flat()).toHaveLength(eventCount);
    expect(store.row.sidecarEventOffset).toBe(eventCount);
    for (const records of accepted) {
      expect(encoder.encode(JSON.stringify(records)).byteLength).toBeLessThan(FIVE_MB);
    }
  });
});

class OneRowStore implements AnalyticsOutboxStore {
  readonly row: AnalyticsOutboxRow;
  failNextMarkSent = false;
  failNextSaveProgress = false;

  constructor(row: AnalyticsOutboxRow) {
    this.row = row;
  }

  async listPending(limit: number): Promise<AnalyticsOutboxRow[]> {
    return this.row.sentAt === null && this.row.quarantinedAt === null && limit > 0
      ? [this.row]
      : [];
  }

  async canSendRecord(): Promise<boolean> {
    return true;
  }

  async markSent(exportSequences: readonly number[], sentAt: number): Promise<void> {
    if (this.failNextMarkSent) {
      this.failNextMarkSent = false;
      throw new Error("state write stopped");
    }
    if (exportSequences.includes(this.row.exportSequence)) {
      this.row.sentAt = sentAt;
      this.row.attemptCount += 1;
      this.row.lastError = null;
    }
  }

  async markFailed(exportSequences: readonly number[], error: string): Promise<void> {
    if (exportSequences.includes(this.row.exportSequence)) {
      this.row.attemptCount += 1;
      this.row.lastError = error;
    }
  }

  async markQuarantined(
    exportSequences: readonly number[],
    reason: string,
    quarantinedAt: number,
  ): Promise<void> {
    if (exportSequences.includes(this.row.exportSequence) && this.row.quarantinedAt === null) {
      this.row.attemptCount += 1;
      this.row.lastError = reason;
      this.row.quarantinedAt = quarantinedAt;
      this.row.quarantineReason = reason;
    }
  }

  async saveSidecarProgress(exportSequence: number, nextEventIndex: number): Promise<void> {
    if (this.failNextSaveProgress) {
      this.failNextSaveProgress = false;
      throw new Error("progress write stopped");
    }
    if (exportSequence === this.row.exportSequence) {
      this.row.sidecarEventOffset = Math.max(this.row.sidecarEventOffset, nextEventIndex);
    }
  }

  async listProjectIds(_limit: number): Promise<string[]> {
    return [];
  }

  async readWarehouseState(projectId: string): Promise<AnalyticsWarehouseState> {
    return {
      projectId,
      verifiedSequence: 0,
      verifiedAt: null,
      lastAttemptAt: null,
      lastError: null,
    };
  }

  async listProjectRowsAfter(
    _projectId: string,
    _verifiedSequence: number,
    _limit: number,
  ): Promise<AnalyticsOutboxRow[]> {
    return [];
  }

  async resetForRetry(_exportSequences: readonly number[], _error: string): Promise<void> {}

  async saveWarehouseState(_input: SaveWarehouseStateInput): Promise<void> {}
}

function collectingPipeline(accepted: AnalyticsWarehouseRecord[][]): AnalyticsPipelineAdapter {
  return {
    async send(records) {
      accepted.push(records.map((record) => ({ ...record })));
    },
  };
}

function fixedSidecarReader(body: ReadableStream<Uint8Array>): AnalyticsSidecarReader {
  return {
    async get() {
      return { body };
    },
  };
}

function lineSidecarReader(lines: readonly Record<string, unknown>[]): AnalyticsSidecarReader {
  const serialized = lines.map((line) => JSON.stringify(line));
  return {
    async get() {
      return { body: streamFromLines(serialized) };
    },
  };
}

function streamFromLines(lines: Iterable<string>): ReadableStream<Uint8Array> {
  const iterator = lines[Symbol.iterator]();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`${next.value}\n`));
    },
  });
}

function byteChunks(value: string, bytesPerChunk: number): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(value);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const nextOffset = Math.min(bytes.byteLength, offset + bytesPerChunk);
      controller.enqueue(bytes.slice(offset, nextOffset));
      offset = nextOffset;
    },
  });
}

function completeSessionRow(eventCount: number): AnalyticsOutboxRow {
  const payload = {
    schema_version: 1,
    record_kind: "session",
    export_id: "session:project:session",
    project_id: "project",
    session_id: "session",
    recorded_at: 200,
    event_coverage: "complete",
    org_id: "org",
    started_at: 100,
    ended_at: 200,
    duration_ms: 100,
    country: null,
    region: null,
    city: null,
    device: null,
    browser: null,
    os: null,
    entry_url: null,
    url_count: 0,
    page_count: 0,
    analytics_version: 2,
    max_scroll_depth: null,
    quick_backs: null,
    interaction_time_ms: null,
    activity_hist: null,
    clicks: 0,
    event_count: eventCount,
    errors: 0,
    rages: 0,
    navs: 0,
    bytes: 10,
    segment_count: 1,
    flags: 0,
    manifest_key: "p/project/session/manifest.json",
    analytics_sidecar_key: "p/project/session/analytics.ndjson",
    expires_at: 300,
  };

  return {
    exportSequence: 7,
    exportId: payload.export_id,
    projectId: payload.project_id,
    sessionId: payload.session_id,
    recordKind: "session",
    payloadJson: JSON.stringify(payload),
    createdAt: 200,
    sentAt: null,
    attemptCount: 0,
    lastError: null,
    quarantinedAt: null,
    quarantineReason: null,
    sidecarEventOffset: 0,
  };
}
