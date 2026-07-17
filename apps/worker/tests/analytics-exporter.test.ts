import { manifestKey, type FinalizeMessage } from "@orange-replay/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildFinalizeAnalyticsRecords,
  MAX_ANALYTICS_RECORD_BYTES,
  type AnalyticsWarehouseRecord,
} from "../src/analytics/export-record.ts";
import { drainAnalyticsExports, reconcileAnalyticsExports } from "../src/analytics/exporter.ts";
import type {
  AnalyticsOutboxRow,
  AnalyticsOutboxStore,
  AnalyticsWarehouseState,
  SaveWarehouseStateInput,
} from "../src/analytics/outbox.ts";

describe("analytics export records", () => {
  it("builds bounded, scrubbed records with stable ids", () => {
    const message = makeFinalizeMessage("stable");
    message.attrs.city = "x".repeat(1_000);
    message.events[0] = {
      t: message.startedAt + 100,
      k: "error",
      d: "private detail".repeat(40),
      m: { ignored: "metadata is not exported" },
    };
    message.events.push({ ...message.events[0] });

    const first = buildFinalizeAnalyticsRecords(message);
    const second = buildFinalizeAnalyticsRecords(message);

    expect(first.serialized).toEqual(second.serialized);
    expect(first.session.export_id).toBe(`session:${message.projectId}:${message.sessionId}`);
    expect(first.session.city).toHaveLength(512);
    expect(first.session.event_coverage).toBe("sparse");
    expect(first.session.event_count).toBe(message.counts.events);
    expect(first.events).toHaveLength(2);
    expect(first.serialized.map((row) => row.recordKind)).toEqual(["event", "event", "session"]);
    expect(first.events[0]?.event_detail).toHaveLength(200);
    expect(first.serialized.every((row) => !row.payloadJson.includes("ignored"))).toBe(true);
    expect(
      first.serialized.every(
        (row) => new TextEncoder().encode(row.payloadJson).byteLength <= MAX_ANALYTICS_RECORD_BYTES,
      ),
    ).toBe(true);
  });

  it("marks a session complete when its immutable analytics sidecar exists", () => {
    const message = makeFinalizeMessage("sidecar");
    message.analyticsSidecarKey = `p/${message.projectId}/${message.sessionId}/analytics.ndjson`;

    const records = buildFinalizeAnalyticsRecords(message);

    expect(records.session.event_coverage).toBe("complete");
    expect(records.session.analytics_sidecar_key).toBe(message.analyticsSidecarKey);
    expect(records.events).toHaveLength(2);
    expect(records.events.every((event) => event.event_coverage === "sparse")).toBe(true);
    expect(records.serialized).toHaveLength(1);
    expect(records.serialized[0]?.recordKind).toBe("session");
  });

  it("uses the same sparse event order as a D1 backfill", () => {
    const message = makeFinalizeMessage("canonical");
    message.events = [
      { t: 200, k: "error", d: "later" },
      { t: 100, k: "custom", d: "first" },
      { t: 200, k: "error", d: "duplicate" },
    ];

    const records = buildFinalizeAnalyticsRecords(message);

    expect(records.events.map((event) => event.export_id)).toEqual([
      `event:${message.projectId}:${message.sessionId}:0:100:custom`,
      `event:${message.projectId}:${message.sessionId}:1:200:error`,
    ]);
  });
});

describe("analytics export delivery", () => {
  it("resends the same stable row after a crash between send and sent status", async () => {
    const store = new MemoryOutboxStore([outboxRow(1, "session:project:session")]);
    const accepted: AnalyticsWarehouseRecord[][] = [];
    const pipeline = {
      async send(records: readonly AnalyticsWarehouseRecord[]) {
        accepted.push([...records]);
      },
    };
    store.failNextMarkSent = true;

    await expect(drainAnalyticsExports(store, pipeline, { now: 10 })).rejects.toThrow(
      "state write stopped",
    );
    await expect(drainAnalyticsExports(store, pipeline, { now: 20 })).resolves.toMatchObject({
      selected: 1,
      sent: 1,
      failed: 0,
    });

    expect(accepted).toHaveLength(2);
    expect(accepted[0]).toEqual(accepted[1]);
    expect(accepted[0]?.[0]).toMatchObject({
      export_id: "session:project:session",
      export_sequence: 1,
    });
    expect(store.rows[0]?.sentAt).toBe(20);
  });

  it("keeps rows pending and records a useful error when delivery fails", async () => {
    const store = new MemoryOutboxStore([outboxRow(1, "session:project:session")]);
    const failingPipeline = {
      send: vi.fn(async () => {
        throw new Error("pipeline is unavailable");
      }),
    };

    await expect(drainAnalyticsExports(store, failingPipeline)).rejects.toThrow(
      "analytics export delivery failed: pipeline is unavailable",
    );

    expect(store.rows[0]).toMatchObject({
      sentAt: null,
      attemptCount: 1,
      lastError: "pipeline is unavailable",
    });
  });

  it("checks project residency again immediately before delivery", async () => {
    const row = outboxRow(1, "session:project:session");
    const store = new MemoryOutboxStore([row]);
    const send = vi.fn(async () => {});
    store.allowedChecksBeforeDeny.set("project", 1);

    await expect(drainAnalyticsExports(store, { send }, { now: 100 })).resolves.toMatchObject({
      selected: 1,
      sent: 0,
      failed: 1,
    });

    expect(send).not.toHaveBeenCalled();
    expect(row.sentAt).toBeNull();
    expect(row.attemptCount).toBe(1);
    expect(row.quarantineReason).toContain("project residency");
  });

  it("sends healthy projects even when an earlier outbox row is bad", async () => {
    const bad = outboxRow(1, "event:bad-project:bad-session:0:1:custom");
    bad.payloadJson = "not json";
    const healthy = outboxRow(2, "event:healthy-project:healthy-session:0:1:custom");
    const store = new MemoryOutboxStore([bad, healthy]);
    const accepted: AnalyticsWarehouseRecord[][] = [];

    await expect(
      drainAnalyticsExports(store, {
        async send(records) {
          accepted.push([...records]);
        },
      }),
    ).resolves.toMatchObject({ selected: 2, sent: 1, failed: 1 });

    expect(bad.sentAt).toBeNull();
    expect(bad.lastError).toContain("invalid JSON");
    expect(healthy.sentAt).not.toBeNull();
    expect(accepted.flat().map((record) => record.export_id)).toEqual([healthy.exportId]);
  });

  it("quarantines a full bad page so later healthy work can be sent", async () => {
    const badRows = Array.from({ length: 90 }, (_, index) => {
      const sequence = index + 1;
      const row = outboxRow(sequence, `session:bad-project:bad-${String(sequence)}`);
      row.payloadJson = "{}";
      return row;
    });
    const healthy = outboxRow(91, "session:healthy-project:healthy-session");
    const store = new MemoryOutboxStore([...badRows, healthy]);
    const accepted: AnalyticsWarehouseRecord[][] = [];
    const pipeline = {
      async send(records: readonly AnalyticsWarehouseRecord[]) {
        accepted.push([...records]);
      },
    };

    await expect(drainAnalyticsExports(store, pipeline, { now: 100 })).resolves.toMatchObject({
      selected: 90,
      sent: 0,
      failed: 90,
    });
    await expect(drainAnalyticsExports(store, pipeline, { now: 200 })).resolves.toMatchObject({
      selected: 1,
      sent: 1,
      failed: 0,
    });

    expect(badRows.every((row) => row.quarantinedAt === 100)).toBe(true);
    expect(healthy.sentAt).toBe(200);
    expect(accepted.flat().map((record) => record.export_id)).toEqual([healthy.exportId]);
  });

  it("quarantines kind-specific records with missing required fields", async () => {
    const incompleteSession = outboxRow(1, "session:project:session");
    const sessionPayload = JSON.parse(incompleteSession.payloadJson) as Record<string, unknown>;
    delete sessionPayload["started_at"];
    incompleteSession.payloadJson = JSON.stringify(sessionPayload);

    const incompleteDeletion = outboxRow(2, "deletion:project:deleted-session");
    const deletionPayload = JSON.parse(incompleteDeletion.payloadJson) as Record<string, unknown>;
    delete deletionPayload["deleted_at"];
    incompleteDeletion.payloadJson = JSON.stringify(deletionPayload);
    const store = new MemoryOutboxStore([incompleteSession, incompleteDeletion]);
    const send = vi.fn(async () => {});

    await expect(drainAnalyticsExports(store, { send }, { now: 300 })).resolves.toMatchObject({
      selected: 2,
      sent: 0,
      failed: 2,
    });
    expect(send).not.toHaveBeenCalled();
    expect(incompleteSession.quarantineReason).toContain("invalid session fields");
    expect(incompleteDeletion.quarantineReason).toContain("invalid deletion fields");
  });

  it("delivers stable duration-recovery records with recorded-time durations", async () => {
    const session = outboxRow(18, "session:project:session");
    const sessionPayload = JSON.parse(session.payloadJson) as Record<string, unknown>;
    session.exportId = "session:duration-recovery-v1:project:session";
    sessionPayload["export_id"] = session.exportId;
    sessionPayload["started_at"] = 100;
    sessionPayload["ended_at"] = 200;
    sessionPayload["duration_ms"] = 25;
    sessionPayload["expires_at"] = 300;
    session.payloadJson = JSON.stringify(sessionPayload);

    const event = outboxRow(19, "event:project:session:0:150:custom");
    const eventPayload = JSON.parse(event.payloadJson) as Record<string, unknown>;
    event.exportId = "event:duration-recovery-v1:project:session:0:150:custom";
    eventPayload["export_id"] = event.exportId;
    event.payloadJson = JSON.stringify(eventPayload);

    const deletion = outboxRow(20, "deletion:project:deleted-session");
    const deletionPayload = JSON.parse(deletion.payloadJson) as Record<string, unknown>;
    deletion.exportId = "deletion:duration-recovery-v1:project:deleted-session";
    deletionPayload["export_id"] = deletion.exportId;
    deletion.payloadJson = JSON.stringify(deletionPayload);

    const accepted: AnalyticsWarehouseRecord[] = [];
    const store = new MemoryOutboxStore([session, event, deletion]);

    await expect(
      drainAnalyticsExports(store, {
        async send(records) {
          accepted.push(...records);
        },
      }),
    ).resolves.toMatchObject({ selected: 3, sent: 3, failed: 0 });

    expect(accepted.map((record) => record.export_id)).toEqual([
      session.exportId,
      event.exportId,
      deletion.exportId,
    ]);
    expect(accepted[0]).toMatchObject({ duration_ms: 25 });
  });
});

describe("analytics warehouse reconciliation", () => {
  it("advances only through the complete visible prefix and retries missing rows", async () => {
    const rows = [
      outboxRow(2, "session:project:first", 100),
      outboxRow(5, "event:project:second", 100),
      outboxRow(9, "event:project:third", 100),
    ];
    const store = new MemoryOutboxStore(rows);
    const visible = new Set([rows[0]?.exportId, rows[2]?.exportId]);

    const first = await reconcileAnalyticsExports(
      store,
      {
        async findVisibleExportIds() {
          return [...visible].filter((value): value is string => value !== undefined);
        },
      },
      { now: 1_000, visibilityDelayMs: 0 },
    );

    expect(first).toMatchObject({
      projectsChecked: 1,
      projectsFailed: 0,
      recordsChecked: 3,
      recordsMissing: 1,
      projectsAdvanced: 1,
    });
    expect(store.state.get("project")?.verifiedSequence).toBe(2);
    expect(store.rows.find((row) => row.exportSequence === 5)?.sentAt).toBeNull();
    expect(store.rows.find((row) => row.exportSequence === 9)?.sentAt).toBe(100);

    await store.markSent([5], 1_100);
    visible.add(rows[1]?.exportId);
    const second = await reconcileAnalyticsExports(
      store,
      {
        async findVisibleExportIds() {
          return [...visible].filter((value): value is string => value !== undefined);
        },
      },
      { now: 1_200, visibilityDelayMs: 0 },
    );

    expect(second.projectsAdvanced).toBe(1);
    expect(store.state.get("project")?.verifiedSequence).toBe(9);
  });

  it("does not move the watermark when the visibility check fails", async () => {
    const store = new MemoryOutboxStore([outboxRow(4, "session:project:session", 100)]);

    const result = await reconcileAnalyticsExports(
      store,
      {
        async findVisibleExportIds() {
          throw new Error("R2 SQL timed out");
        },
      },
      { now: 1_000 },
    );

    expect(store.state.get("project")).toMatchObject({
      verifiedSequence: 0,
      lastAttemptAt: 1_000,
      lastError: "R2 SQL timed out",
    });
    expect(result.projectsFailed).toBe(1);
  });

  it("records an attempt when a project is still waiting for delivery", async () => {
    const store = new MemoryOutboxStore([outboxRow(1, "session:waiting:session")]);

    const result = await reconcileAnalyticsExports(
      store,
      {
        async findVisibleExportIds() {
          throw new Error("visibility should not run before delivery");
        },
      },
      { now: 500 },
    );

    expect(result.projectsChecked).toBe(0);
    expect(store.state.get("waiting")).toMatchObject({
      verifiedSequence: 0,
      lastAttemptAt: 500,
      lastError: null,
    });
  });

  it("never advances a project watermark past a quarantined row", async () => {
    const poison = outboxRow(1, "session:project:poison");
    poison.payloadJson = "{}";
    const healthy = outboxRow(2, "session:project:healthy");
    const store = new MemoryOutboxStore([poison, healthy]);
    const visible = new Set<string>();
    await drainAnalyticsExports(
      store,
      {
        async send(records) {
          for (const record of records) visible.add(record.export_id);
        },
      },
      { now: 100 },
    );

    const result = await reconcileAnalyticsExports(
      store,
      {
        async findVisibleExportIds() {
          return visible;
        },
      },
      { now: 200, visibilityDelayMs: 0 },
    );

    expect(poison.quarantinedAt).toBe(100);
    expect(healthy.sentAt).toBe(100);
    expect(result.projectsAdvanced).toBe(0);
    expect(store.state.get("project")?.verifiedSequence).toBe(0);
  });
});

class MemoryOutboxStore implements AnalyticsOutboxStore {
  readonly rows: AnalyticsOutboxRow[];
  readonly state = new Map<string, AnalyticsWarehouseState>();
  readonly allowedChecksBeforeDeny = new Map<string, number>();
  failNextMarkSent = false;

  constructor(rows: AnalyticsOutboxRow[]) {
    this.rows = rows;
  }

  async listPending(limit: number): Promise<AnalyticsOutboxRow[]> {
    return this.rows
      .filter((row) => row.sentAt === null && row.quarantinedAt === null)
      .slice(0, limit);
  }

  async canSendRecord(
    projectId: string,
    _sessionId: string,
    recordKind: AnalyticsOutboxRow["recordKind"],
  ): Promise<boolean> {
    if (recordKind === "deletion") return true;
    const checksLeft = this.allowedChecksBeforeDeny.get(projectId);
    if (checksLeft === undefined) return true;
    if (checksLeft <= 0) return false;
    this.allowedChecksBeforeDeny.set(projectId, checksLeft - 1);
    return true;
  }

  async markSent(exportSequences: readonly number[], sentAt: number): Promise<void> {
    if (this.failNextMarkSent) {
      this.failNextMarkSent = false;
      throw new Error("state write stopped");
    }
    for (const row of this.rows) {
      if (exportSequences.includes(row.exportSequence)) {
        row.sentAt = sentAt;
        row.attemptCount += 1;
        row.lastError = null;
      }
    }
  }

  async markFailed(exportSequences: readonly number[], error: string): Promise<void> {
    for (const row of this.rows) {
      if (exportSequences.includes(row.exportSequence)) {
        row.attemptCount += 1;
        row.lastError = error;
      }
    }
  }

  async markQuarantined(
    exportSequences: readonly number[],
    reason: string,
    quarantinedAt: number,
  ): Promise<void> {
    for (const row of this.rows) {
      if (exportSequences.includes(row.exportSequence) && row.quarantinedAt === null) {
        row.attemptCount += 1;
        row.lastError = reason;
        row.quarantinedAt = quarantinedAt;
        row.quarantineReason = reason;
      }
    }
  }

  async saveSidecarProgress(exportSequence: number, nextEventIndex: number): Promise<void> {
    const row = this.rows.find((item) => item.exportSequence === exportSequence);
    if (row !== undefined)
      row.sidecarEventOffset = Math.max(row.sidecarEventOffset, nextEventIndex);
  }

  async listProjectIds(limit: number): Promise<string[]> {
    return [...new Set(this.rows.map((row) => row.projectId))]
      .filter((projectId) =>
        this.rows.some(
          (row) =>
            row.projectId === projectId &&
            row.exportSequence > (this.state.get(projectId)?.verifiedSequence ?? 0),
        ),
      )
      .slice(0, limit);
  }

  async readWarehouseState(projectId: string): Promise<AnalyticsWarehouseState> {
    return (
      this.state.get(projectId) ?? {
        projectId,
        verifiedSequence: 0,
        verifiedAt: null,
        lastAttemptAt: null,
        lastError: null,
      }
    );
  }

  async listProjectRowsAfter(
    projectId: string,
    verifiedSequence: number,
    limit: number,
  ): Promise<AnalyticsOutboxRow[]> {
    return this.rows
      .filter((row) => row.projectId === projectId && row.exportSequence > verifiedSequence)
      .sort((left, right) => left.exportSequence - right.exportSequence)
      .slice(0, limit);
  }

  async resetForRetry(exportSequences: readonly number[], error: string): Promise<void> {
    for (const row of this.rows) {
      if (exportSequences.includes(row.exportSequence)) {
        row.sentAt = null;
        row.lastError = error;
      }
    }
  }

  async saveWarehouseState(input: SaveWarehouseStateInput): Promise<void> {
    const current = await this.readWarehouseState(input.projectId);
    const advanced = input.verifiedSequence > current.verifiedSequence;
    this.state.set(input.projectId, {
      projectId: input.projectId,
      verifiedSequence: advanced ? input.verifiedSequence : current.verifiedSequence,
      verifiedAt: advanced ? input.verifiedAt : current.verifiedAt,
      lastAttemptAt: input.lastAttemptAt,
      lastError: input.lastError,
    });
  }
}

function outboxRow(
  exportSequence: number,
  exportId: string,
  sentAt: number | null = null,
): AnalyticsOutboxRow {
  const [recordKind = "session", projectId = "project", sessionId = "session"] =
    exportId.split(":");
  const payload = testPayload(exportId, recordKind, projectId, sessionId);
  return {
    exportSequence,
    exportId,
    projectId,
    sessionId,
    recordKind: recordKind as AnalyticsOutboxRow["recordKind"],
    payloadJson: JSON.stringify(payload),
    createdAt: 1,
    sentAt,
    attemptCount: 0,
    lastError: null,
    quarantinedAt: null,
    quarantineReason: null,
    sidecarEventOffset: 0,
  };
}

function testPayload(
  exportId: string,
  recordKind: string,
  projectId: string,
  sessionId: string,
): Record<string, unknown> {
  const common = {
    schema_version: 1,
    record_kind: recordKind,
    export_id: exportId,
    project_id: projectId,
    session_id: sessionId,
    recorded_at: 1,
    event_coverage: "sparse",
  };
  if (recordKind === "event") {
    const parts = exportId.split(":");
    return {
      ...common,
      event_index: Number(parts[3]),
      event_time: Number(parts[4]),
      event_kind: parts[5],
      event_detail: null,
    };
  }
  if (recordKind === "deletion") {
    return {
      ...common,
      event_coverage: "none",
      deleted_at: 1,
      delete_reason: "retention",
    };
  }
  return {
    ...common,
    org_id: "org",
    started_at: 1,
    ended_at: 2,
    duration_ms: 1,
    country: null,
    region: null,
    city: null,
    device: null,
    browser: null,
    os: null,
    entry_url: null,
    url_count: 1,
    page_count: null,
    analytics_version: 0,
    max_scroll_depth: null,
    quick_backs: null,
    interaction_time_ms: null,
    activity_hist: null,
    clicks: 0,
    event_count: 0,
    errors: 0,
    rages: 0,
    navs: 0,
    bytes: 0,
    segment_count: 0,
    flags: 0,
    manifest_key: `p/${projectId}/${sessionId}/manifest.json`,
    analytics_sidecar_key: null,
    expires_at: 3,
  };
}

function makeFinalizeMessage(name: string): FinalizeMessage {
  const projectId = `project-${name}`;
  const sessionId = `session-${name}`;
  const startedAt = Date.UTC(2026, 0, 15, 10, 0, 0);

  return {
    type: "session.finalized",
    projectId,
    sessionId,
    orgId: `org-${name}`,
    shard: 0,
    requestId: `request-${name}`,
    manifestKey: manifestKey(projectId, sessionId),
    startedAt,
    endedAt: startedAt + 10_000,
    bytes: 500,
    segments: 2,
    flags: 0,
    analyticsVersion: 2,
    insights: {
      maxScrollDepth: 80,
      quickBacks: 1,
      interactionTimeMs: 5_000,
      activityHist: "1a2b3c4d",
    },
    counts: { batches: 2, events: 4, clicks: 1, errors: 1, rages: 0, navs: 1 },
    attrs: {
      country: "US",
      city: "San Francisco",
      entryUrl: "/checkout",
      urlCount: 2,
      pageCount: 2,
    },
    retentionDays: 30,
    events: [
      { t: startedAt + 100, k: "error", d: "failed" },
      { t: startedAt + 200, k: "custom", d: "checkout" },
    ],
  };
}
