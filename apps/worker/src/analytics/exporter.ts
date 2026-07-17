import {
  addExportSequence,
  ANALYTICS_RECORD_SCHEMA_VERSION,
  eventExportId,
  MAX_ANALYTICS_RECORD_BYTES,
  type AnalyticsOutboxPayload,
  type AnalyticsSessionRecord,
  type AnalyticsWarehouseRecord,
} from "./export-record.ts";
import {
  safeOutboxBatchSize,
  type AnalyticsOutboxRow,
  type AnalyticsOutboxStore,
} from "./outbox.ts";

const DEFAULT_PROJECT_LIMIT = 100;
const DEFAULT_VISIBILITY_BATCH_SIZE = 500;
const DEFAULT_VISIBILITY_DELAY_MS = 60_000;
const MAX_PIPELINE_BATCH_BYTES = 5_000_000;
const MAX_EVENT_DETAIL_CHARS = 200;
const MAX_EVENT_META_KEYS = 16;
const MAX_EVENT_META_KEY_CHARS = 200;
const MAX_EVENT_META_VALUE_CHARS = 200;
const DEFAULT_SIDECAR_READ_TIMEOUT_MS = 15_000;
const MAX_SIDECAR_READ_TIMEOUT_MS = 60_000;
const ANALYTICS_SIDECAR_HEADER_VERSION = 1;
const COMPLETE_COVERAGE_EVENT_KIND = "coverage_complete";
const allowedEventKinds = new Set([
  "click",
  "rage",
  "error",
  "nav",
  "custom",
  "input",
  "scroll",
  "vital",
]);
const utf8Encoder = new TextEncoder();

export interface AnalyticsPipelineAdapter {
  send(records: readonly AnalyticsWarehouseRecord[]): Promise<void>;
}

export interface AnalyticsSidecarObject {
  body: ReadableStream<Uint8Array>;
}

/** R2Bucket matches this small read-only surface. */
export interface AnalyticsSidecarReader {
  get(key: string): Promise<AnalyticsSidecarObject | null>;
}

export interface AnalyticsVisibilityAdapter {
  findVisibleExportIds(input: {
    projectId: string;
    exportIds: readonly string[];
    sessionIds: readonly string[];
    throughSequence: number;
  }): Promise<ReadonlySet<string> | readonly string[]>;
}

export interface DrainAnalyticsExportsResult {
  selected: number;
  sent: number;
  failed: number;
  firstSequence: number | null;
  lastSequence: number | null;
}

export interface ReconcileAnalyticsExportsResult {
  projectsChecked: number;
  projectsFailed: number;
  recordsChecked: number;
  recordsMissing: number;
  projectsAdvanced: number;
}

export async function drainAnalyticsExports(
  store: AnalyticsOutboxStore,
  pipeline: AnalyticsPipelineAdapter,
  options: {
    limit?: number;
    now?: number;
    sidecarReader?: AnalyticsSidecarReader;
    sidecarReadTimeoutMs?: number;
  } = {},
): Promise<DrainAnalyticsExportsResult> {
  const now = options.now ?? Date.now();
  const sidecarReadTimeoutMs = checkedSidecarReadTimeout(options.sidecarReadTimeoutMs);
  const rows = await store.listPending(safeOutboxBatchSize(options.limit));
  if (rows.length === 0) {
    return { selected: 0, sent: 0, failed: 0, firstSequence: null, lastSequence: null };
  }

  const sequences = rows.map((row) => row.exportSequence);
  let sent = 0;
  let failed = 0;
  let legacyRows: AnalyticsOutboxRow[] = [];
  let legacyRecords: AnalyticsWarehouseRecord[] = [];
  let legacyGroup: string | null = null;
  const flushLegacy = async (): Promise<void> => {
    const result = await sendLegacyRows(store, pipeline, legacyRows, legacyRecords, now);
    sent += result.sent;
    failed += result.denied;
    legacyRows = [];
    legacyRecords = [];
    legacyGroup = null;
  };

  for (const row of rows) {
    if (!(await store.canSendRecord(row.projectId, row.sessionId, row.recordKind))) {
      await store.markQuarantined([row.exportSequence], blockedRecordReason(row), now);
      failed += 1;
      continue;
    }

    let record: AnalyticsWarehouseRecord;
    try {
      record = toWarehouseRecord(row);
    } catch (error) {
      await store.markQuarantined([row.exportSequence], storedFailureMessage(error), now);
      failed += 1;
      continue;
    }

    if (!hasCompleteSidecar(record)) {
      const nextGroup = legacyRecordGroup(row);
      if (legacyGroup !== null && legacyGroup !== nextGroup) {
        await flushLegacy();
      }
      legacyGroup = nextGroup;
      legacyRows.push(row);
      legacyRecords.push(record);
      continue;
    }

    await flushLegacy();
    try {
      await sendCompleteSidecar(
        row,
        record,
        store,
        pipeline,
        options.sidecarReader,
        sidecarReadTimeoutMs,
        () => store.canSendRecord(row.projectId, row.sessionId, row.recordKind),
      );
    } catch (error) {
      if (error instanceof AnalyticsResidencyChangedError) {
        await store.markQuarantined([row.exportSequence], blockedRecordReason(row), now);
        failed += 1;
        continue;
      }
      if (
        error instanceof AnalyticsPipelineError ||
        error instanceof AnalyticsSidecarReadError ||
        error instanceof AnalyticsSidecarProgressError
      ) {
        await store.markFailed([row.exportSequence], storedFailureMessage(error));
        throw exposedFailure(error);
      }
      await store.markQuarantined([row.exportSequence], storedFailureMessage(error), now);
      failed += 1;
      continue;
    }

    // The marker is accepted before this state write. A stopped Worker sends
    // the same stable session, event, and marker IDs again on its next run.
    await store.markSent([row.exportSequence], now);
    sent += 1;
  }

  await flushLegacy();

  return {
    selected: rows.length,
    sent,
    failed,
    firstSequence: sequences[0] ?? null,
    lastSequence: sequences.at(-1) ?? null,
  };
}

type CompleteSessionWarehouseRecord = AnalyticsSessionRecord & {
  export_sequence: number;
};

type SidecarWarehouseEvent = AnalyticsWarehouseRecord & {
  event_meta_json: string | null;
};

interface SidecarEventLine {
  eventIndex: number;
  eventTime: number;
  eventKind: string;
  eventDetail: string | null;
  eventMetaJson: string | null;
}

async function sendLegacyRows(
  store: AnalyticsOutboxStore,
  pipeline: AnalyticsPipelineAdapter,
  rows: readonly AnalyticsOutboxRow[],
  records: readonly AnalyticsWarehouseRecord[],
  now: number | undefined,
): Promise<{ sent: number; denied: number }> {
  if (rows.length === 0) return { sent: 0, denied: 0 };
  const firstRow = rows[0];
  if (
    firstRow === undefined ||
    !(await store.canSendRecord(firstRow.projectId, firstRow.sessionId, firstRow.recordKind))
  ) {
    if (firstRow !== undefined) {
      await store.markQuarantined(
        rows.map((row) => row.exportSequence),
        blockedRecordReason(firstRow),
        now ?? Date.now(),
      );
    }
    return { sent: 0, denied: rows.length };
  }
  const sequences = rows.map((row) => row.exportSequence);

  try {
    await pipeline.send(records);
  } catch (error) {
    await store.markFailed(sequences, errorMessage(error));
    throw new Error(`analytics export delivery failed: ${errorMessage(error)}`, { cause: error });
  }

  // This write intentionally happens after Pipeline acceptance. If the Worker
  // stops between these two calls, the same stable IDs are sent again.
  await store.markSent(sequences, now ?? Date.now());
  return { sent: rows.length, denied: 0 };
}

function hasCompleteSidecar(
  record: AnalyticsWarehouseRecord,
): record is CompleteSessionWarehouseRecord {
  return record.record_kind === "session" && record.event_coverage === "complete";
}

async function sendCompleteSidecar(
  row: AnalyticsOutboxRow,
  session: CompleteSessionWarehouseRecord,
  store: AnalyticsOutboxStore,
  pipeline: AnalyticsPipelineAdapter,
  sidecarReader: AnalyticsSidecarReader | undefined,
  sidecarReadTimeoutMs: number,
  canSend: () => Promise<boolean>,
): Promise<void> {
  const sidecarKey = checkedSidecarKey(session);
  const expectedEventCount = checkedEventCount(session);
  const resumeAtEventIndex = row.sidecarEventOffset;
  if (
    !Number.isSafeInteger(resumeAtEventIndex) ||
    resumeAtEventIndex < 0 ||
    resumeAtEventIndex > expectedEventCount
  ) {
    throw new AnalyticsSidecarError(
      `analytics export ${session.export_id} has invalid saved sidecar progress`,
    );
  }

  // The summary is useful independently, but warehouse visibility does not
  // accept a complete summary until the marker below is also visible.
  await sendToPipeline(pipeline, [session], canSend);

  if (sidecarReader === undefined) {
    throw new AnalyticsSidecarError(
      `analytics export ${session.export_id} needs an analytics sidecar reader`,
    );
  }

  let sidecarObject: AnalyticsSidecarObject | null;
  try {
    sidecarObject = await withTimeout(
      sidecarReader.get(sidecarKey),
      sidecarReadTimeoutMs,
      "analytics sidecar object read",
    );
  } catch (error) {
    throw new AnalyticsSidecarReadError(
      `analytics export ${session.export_id} could not read its analytics sidecar: ${errorMessage(error)}`,
      error,
    );
  }
  if (sidecarObject === null) {
    throw new AnalyticsSidecarError(
      `analytics export ${session.export_id} is missing its analytics sidecar`,
    );
  }
  if (!isReadableByteStream(sidecarObject.body)) {
    throw new AnalyticsSidecarError(
      `analytics export ${session.export_id} returned an invalid analytics sidecar stream`,
    );
  }

  let sawHeader = false;
  let eventCount = 0;
  let batch: SidecarWarehouseEvent[] = [];
  let batchBytes = 2;

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    await sendToPipeline(pipeline, batch, canSend);
    try {
      await store.saveSidecarProgress(row.exportSequence, eventCount);
    } catch (error) {
      throw new AnalyticsSidecarProgressError(
        `analytics export ${session.export_id} could not save sidecar progress: ${errorMessage(error)}`,
        error,
      );
    }
    batch = [];
    batchBytes = 2;
  };

  try {
    for await (const line of readNdjsonLines(sidecarObject.body, sidecarReadTimeoutMs)) {
      if (!sawHeader) {
        checkSidecarHeader(line, session.export_id);
        sawHeader = true;
        continue;
      }
      if (eventCount >= expectedEventCount) {
        throw new AnalyticsSidecarError(
          `analytics export ${session.export_id} sidecar has more than ${String(expectedEventCount)} events`,
        );
      }

      const parsed = parseSidecarEvent(line, eventCount, session.export_id);
      if (eventCount < resumeAtEventIndex) {
        eventCount += 1;
        continue;
      }
      const event = buildSidecarEventRecord(session, parsed);
      const eventBytes = serializedRecordBytes(event);
      const nextBatchBytes = batchBytes + eventBytes + (batch.length === 0 ? 0 : 1);
      if (nextBatchBytes >= MAX_PIPELINE_BATCH_BYTES) {
        await flushBatch();
      }
      batch.push(event);
      batchBytes += eventBytes + (batch.length === 1 ? 0 : 1);
      eventCount += 1;
    }
  } catch (error) {
    if (
      error instanceof AnalyticsSidecarError ||
      error instanceof AnalyticsSidecarReadError ||
      error instanceof AnalyticsSidecarProgressError ||
      error instanceof AnalyticsPipelineError ||
      error instanceof AnalyticsResidencyChangedError
    ) {
      throw error;
    }
    throw new AnalyticsSidecarError(
      `analytics export ${session.export_id} could not parse its analytics sidecar: ${errorMessage(error)}`,
      error,
    );
  }

  if (!sawHeader) {
    throw new AnalyticsSidecarError(
      `analytics export ${session.export_id} analytics sidecar is empty`,
    );
  }
  if (eventCount !== expectedEventCount) {
    throw new AnalyticsSidecarError(
      `analytics export ${session.export_id} sidecar has ${String(eventCount)} events; expected ${String(expectedEventCount)}`,
    );
  }

  await flushBatch();
  await sendToPipeline(pipeline, [buildCoverageMarker(session, expectedEventCount)], canSend);
}

function legacyRecordGroup(row: AnalyticsOutboxRow): string {
  return row.recordKind === "deletion"
    ? `deletion:${row.projectId}:${row.sessionId}`
    : `analytics:${row.projectId}`;
}

function blockedRecordReason(row: AnalyticsOutboxRow): string {
  return row.recordKind === "deletion"
    ? "Analytics deletion stopped because its required cleanup job is missing."
    : "Analytics export stopped because the project residency no longer allows it.";
}

function checkedSidecarKey(session: CompleteSessionWarehouseRecord): string {
  const value = session.analytics_sidecar_key;
  const expected = `p/${session.project_id}/${session.session_id}/analytics.ndjson`;
  if (typeof value !== "string" || value !== expected || value.length > 512) {
    throw new AnalyticsSidecarError(
      `analytics export ${session.export_id} has an invalid analytics sidecar key`,
    );
  }
  return value;
}

function checkedEventCount(session: CompleteSessionWarehouseRecord): number {
  const value = session.event_count;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AnalyticsSidecarError(
      `analytics export ${session.export_id} has an invalid event count`,
    );
  }
  return value;
}

function checkSidecarHeader(line: string, exportId: string): void {
  const parsed = parseJsonObject(line, exportId, "header");
  if (
    parsed["v"] !== ANALYTICS_SIDECAR_HEADER_VERSION ||
    parsed["coverage"] !== "complete" ||
    !hasOnlyKeys(parsed, ["v", "coverage"])
  ) {
    throw new AnalyticsSidecarError(
      `analytics export ${exportId} has an invalid analytics sidecar header`,
    );
  }
}

function parseSidecarEvent(
  line: string,
  expectedIndex: number,
  exportId: string,
): SidecarEventLine {
  const parsed = parseJsonObject(line, exportId, `event ${String(expectedIndex)}`);
  if (
    !hasOnlyKeys(parsed, [
      "event_index",
      "event_time",
      "event_kind",
      "event_detail",
      "event_meta",
    ]) ||
    !Number.isSafeInteger(parsed["event_index"]) ||
    parsed["event_index"] !== expectedIndex ||
    !Number.isSafeInteger(parsed["event_time"]) ||
    typeof parsed["event_kind"] !== "string" ||
    !allowedEventKinds.has(parsed["event_kind"])
  ) {
    throw new AnalyticsSidecarError(
      `analytics export ${exportId} has invalid fields in sidecar event ${String(expectedIndex)}`,
    );
  }

  const detail = parsed["event_detail"];
  if (
    detail !== undefined &&
    (typeof detail !== "string" || detail.length > MAX_EVENT_DETAIL_CHARS)
  ) {
    throw new AnalyticsSidecarError(
      `analytics export ${exportId} has invalid detail in sidecar event ${String(expectedIndex)}`,
    );
  }

  return {
    eventIndex: expectedIndex,
    eventTime: parsed["event_time"] as number,
    eventKind: parsed["event_kind"],
    eventDetail: detail ?? null,
    eventMetaJson: checkedEventMetaJson(parsed["event_meta"], exportId, expectedIndex),
  };
}

function checkedEventMetaJson(value: unknown, exportId: string, eventIndex: number): string | null {
  if (value === undefined) return null;
  if (!isObject(value)) {
    throw invalidEventMeta(exportId, eventIndex);
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_EVENT_META_KEYS) {
    throw invalidEventMeta(exportId, eventIndex);
  }
  for (const [key, item] of entries) {
    if (key.length === 0 || key.length > MAX_EVENT_META_KEY_CHARS) {
      throw invalidEventMeta(exportId, eventIndex);
    }
    if (typeof item === "string") {
      if (item.length > MAX_EVENT_META_VALUE_CHARS) {
        throw invalidEventMeta(exportId, eventIndex);
      }
      continue;
    }
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw invalidEventMeta(exportId, eventIndex);
    }
  }

  const json = JSON.stringify(value);
  if (typeof json !== "string") throw invalidEventMeta(exportId, eventIndex);
  return json;
}

function invalidEventMeta(exportId: string, eventIndex: number): AnalyticsSidecarError {
  return new AnalyticsSidecarError(
    `analytics export ${exportId} has invalid metadata in sidecar event ${String(eventIndex)}`,
  );
}

function buildSidecarEventRecord(
  session: CompleteSessionWarehouseRecord,
  event: SidecarEventLine,
): SidecarWarehouseEvent {
  const record = {
    schema_version: ANALYTICS_RECORD_SCHEMA_VERSION,
    record_kind: "event",
    export_id: eventExportId(
      session.project_id,
      session.session_id,
      event.eventIndex,
      event.eventTime,
      event.eventKind,
    ),
    export_sequence: session.export_sequence,
    project_id: session.project_id,
    session_id: session.session_id,
    recorded_at: event.eventTime,
    event_coverage: "complete",
    event_index: event.eventIndex,
    event_time: event.eventTime,
    event_kind: event.eventKind,
    event_detail: event.eventDetail,
    event_meta_json: event.eventMetaJson,
  } satisfies SidecarWarehouseEvent;
  assertWarehouseRecordFits(record);
  return record;
}

function buildCoverageMarker(
  session: CompleteSessionWarehouseRecord,
  eventCount: number,
): SidecarWarehouseEvent {
  const record = {
    schema_version: ANALYTICS_RECORD_SCHEMA_VERSION,
    record_kind: "event",
    // The visibility query deliberately joins this ID to the session row.
    export_id: session.export_id,
    export_sequence: session.export_sequence,
    project_id: session.project_id,
    session_id: session.session_id,
    recorded_at: session.recorded_at,
    event_coverage: "complete",
    event_index: eventCount,
    event_time: session.ended_at,
    event_kind: COMPLETE_COVERAGE_EVENT_KIND,
    event_detail: null,
    event_meta_json: null,
  } satisfies SidecarWarehouseEvent;
  assertWarehouseRecordFits(record);
  return record;
}

async function sendToPipeline(
  pipeline: AnalyticsPipelineAdapter,
  records: readonly AnalyticsWarehouseRecord[],
  canSend: () => Promise<boolean>,
): Promise<void> {
  if (!(await canSend())) {
    throw new AnalyticsResidencyChangedError();
  }
  try {
    await pipeline.send(records);
  } catch (error) {
    throw new AnalyticsPipelineError(errorMessage(error), error);
  }
}

async function* readNdjsonLines(
  stream: ReadableStream<Uint8Array>,
  readTimeoutMs: number,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let buffered = "";
  let reachedEnd = false;

  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await withTimeout(reader.read(), readTimeoutMs, "analytics sidecar stream read");
      } catch (error) {
        throw new AnalyticsSidecarReadError(
          `analytics sidecar stream could not be read: ${errorMessage(error)}`,
          error,
        );
      }
      if (next.done) {
        reachedEnd = true;
        buffered += decoder.decode();
        break;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new Error("analytics sidecar returned a non-byte chunk");
      }
      buffered += decoder.decode(next.value, { stream: true });

      let lineEnd = buffered.indexOf("\n");
      while (lineEnd !== -1) {
        const line = stripCarriageReturn(buffered.slice(0, lineEnd));
        checkNdjsonLineSize(line);
        if (line.length === 0) throw new Error("analytics sidecar contains an empty line");
        yield line;
        buffered = buffered.slice(lineEnd + 1);
        lineEnd = buffered.indexOf("\n");
      }
      checkPartialLineSize(buffered);
    }

    if (buffered.length > 0) {
      const line = stripCarriageReturn(buffered);
      checkNdjsonLineSize(line);
      if (line.length === 0) throw new Error("analytics sidecar contains an empty line");
      yield line;
    }
  } finally {
    if (!reachedEnd) {
      try {
        await withTimeout(reader.cancel(), readTimeoutMs, "analytics sidecar stream cancel");
      } catch {
        // The parse error is more useful than an R2 cancellation error.
      }
    }
    reader.releaseLock();
  }
}

function checkedSidecarReadTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_SIDECAR_READ_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_SIDECAR_READ_TIMEOUT_MS) {
    throw new Error("Analytics sidecar read timeout must be from 1 to 60000 milliseconds.");
  }
  return timeout;
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(milliseconds)} milliseconds`));
    }, milliseconds);
  });
  try {
    return await Promise.race([promise, stopped]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function checkPartialLineSize(value: string): void {
  if (
    value.length > MAX_ANALYTICS_RECORD_BYTES ||
    (value.length > MAX_ANALYTICS_RECORD_BYTES / 3 &&
      utf8Encoder.encode(value).byteLength > MAX_ANALYTICS_RECORD_BYTES)
  ) {
    throw new Error("analytics sidecar line is larger than 32 KiB");
  }
}

function checkNdjsonLineSize(value: string): void {
  if (utf8Encoder.encode(value).byteLength > MAX_ANALYTICS_RECORD_BYTES) {
    throw new Error("analytics sidecar line is larger than 32 KiB");
  }
}

function stripCarriageReturn(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

function parseJsonObject(line: string, exportId: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new AnalyticsSidecarError(
      `analytics export ${exportId} has invalid JSON in its sidecar ${label}`,
    );
  }
  if (!isObject(parsed)) {
    throw new AnalyticsSidecarError(
      `analytics export ${exportId} sidecar ${label} must be an object`,
    );
  }
  return parsed;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isReadableByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    value !== null &&
    typeof value === "object" &&
    "getReader" in value &&
    typeof value.getReader === "function"
  );
}

function serializedRecordBytes(record: AnalyticsWarehouseRecord): number {
  return utf8Encoder.encode(JSON.stringify(record)).byteLength;
}

function assertWarehouseRecordFits(record: AnalyticsWarehouseRecord): void {
  const size = serializedRecordBytes(record);
  if (size > MAX_ANALYTICS_RECORD_BYTES) {
    throw new AnalyticsSidecarError(`analytics export ${record.export_id} is larger than 32 KiB`);
  }
}

class AnalyticsSidecarError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AnalyticsSidecarError";
  }
}

class AnalyticsSidecarReadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AnalyticsSidecarReadError";
  }
}

class AnalyticsSidecarProgressError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AnalyticsSidecarProgressError";
  }
}

class AnalyticsPipelineError extends Error {
  readonly failureMessage: string;

  constructor(failureMessage: string, cause?: unknown) {
    super(
      `analytics export delivery failed: ${failureMessage}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "AnalyticsPipelineError";
    this.failureMessage = failureMessage;
  }
}

class AnalyticsResidencyChangedError extends Error {
  constructor() {
    super("Analytics export stopped because the project residency changed.");
    this.name = "AnalyticsResidencyChangedError";
  }
}

function storedFailureMessage(error: unknown): string {
  return error instanceof AnalyticsPipelineError ? error.failureMessage : errorMessage(error);
}

function exposedFailure(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function reconcileAnalyticsExports(
  store: AnalyticsOutboxStore,
  visibility: AnalyticsVisibilityAdapter,
  options: {
    projectLimit?: number;
    recordsPerProject?: number;
    visibilityDelayMs?: number;
    now?: number;
  } = {},
): Promise<ReconcileAnalyticsExportsResult> {
  const now = options.now ?? Date.now();
  const visibilityDelayMs = Math.max(0, options.visibilityDelayMs ?? DEFAULT_VISIBILITY_DELAY_MS);
  const projectIds = await store.listProjectIds(
    safeOutboxBatchSize(options.projectLimit ?? DEFAULT_PROJECT_LIMIT),
  );
  const result: ReconcileAnalyticsExportsResult = {
    projectsChecked: 0,
    projectsFailed: 0,
    recordsChecked: 0,
    recordsMissing: 0,
    projectsAdvanced: 0,
  };

  for (const projectId of projectIds) {
    const state = await store.readWarehouseState(projectId);
    const rows = await store.listProjectRowsAfter(
      projectId,
      state.verifiedSequence,
      safeOutboxBatchSize(options.recordsPerProject ?? DEFAULT_VISIBILITY_BATCH_SIZE),
    );
    const sentPrefix = rows.slice(0, firstUnsentIndex(rows));
    if (sentPrefix.length === 0) {
      // Record the attempt even when delivery is still pending. Fair project
      // ordering can then rotate this project behind work not checked yet.
      await store.saveWarehouseState({
        projectId,
        verifiedSequence: state.verifiedSequence,
        verifiedAt: null,
        lastAttemptAt: now,
        lastError: state.lastError,
      });
      continue;
    }

    result.projectsChecked += 1;
    result.recordsChecked += sentPrefix.length;
    const lastCandidate = sentPrefix.at(-1);
    if (lastCandidate === undefined) continue;

    let visibleIds: Set<string>;
    try {
      const visible = await visibility.findVisibleExportIds({
        projectId,
        exportIds: sentPrefix.map((row) => row.exportId),
        sessionIds: [...new Set(sentPrefix.map((row) => row.sessionId))],
        throughSequence: lastCandidate.exportSequence,
      });
      visibleIds = new Set(visible);
    } catch (error) {
      await store.saveWarehouseState({
        projectId,
        verifiedSequence: state.verifiedSequence,
        verifiedAt: null,
        lastAttemptAt: now,
        lastError: errorMessage(error),
      });
      result.projectsFailed += 1;
      continue;
    }

    const firstMissing = sentPrefix.findIndex((row) => !visibleIds.has(row.exportId));
    const verifiedPrefix = firstMissing === -1 ? sentPrefix : sentPrefix.slice(0, firstMissing);
    const missingRows = sentPrefix.filter((row) => !visibleIds.has(row.exportId));
    const retryableMissingRows = missingRows.filter(
      (row) => row.sentAt !== null && row.sentAt <= now - visibilityDelayMs,
    );
    const verifiedSequence = verifiedPrefix.at(-1)?.exportSequence ?? state.verifiedSequence;
    const advanced = verifiedSequence > state.verifiedSequence;
    const lastError =
      missingRows.length === 0
        ? null
        : `${missingRows.length} analytics export${missingRows.length === 1 ? " is" : "s are"} not visible yet`;

    if (retryableMissingRows.length > 0) {
      await store.resetForRetry(
        retryableMissingRows.map((row) => row.exportSequence),
        lastError ?? "analytics export is not visible yet",
      );
    }
    await store.saveWarehouseState({
      projectId,
      verifiedSequence,
      verifiedAt: advanced ? now : null,
      lastAttemptAt: now,
      lastError,
    });

    result.recordsMissing += missingRows.length;
    if (advanced) result.projectsAdvanced += 1;
  }

  return result;
}

function toWarehouseRecord(row: AnalyticsOutboxRow): AnalyticsWarehouseRecord {
  const payload = parsePayload(row);
  const record = addExportSequence(payload, row.exportSequence);
  const size = utf8Encoder.encode(JSON.stringify(record)).byteLength;
  if (size > MAX_ANALYTICS_RECORD_BYTES) {
    throw new Error(`analytics export ${row.exportId} is larger than 32 KiB`);
  }
  return record;
}

function parsePayload(row: AnalyticsOutboxRow): AnalyticsOutboxPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadJson) as unknown;
  } catch {
    throw new Error(`analytics export ${row.exportId} has invalid JSON`);
  }
  if (!isObject(parsed)) {
    throw new Error(`analytics export ${row.exportId} must be an object`);
  }
  if (
    parsed["schema_version"] !== ANALYTICS_RECORD_SCHEMA_VERSION ||
    parsed["record_kind"] !== row.recordKind ||
    parsed["export_id"] !== row.exportId ||
    parsed["project_id"] !== row.projectId ||
    parsed["session_id"] !== row.sessionId ||
    typeof parsed["recorded_at"] !== "number" ||
    !Number.isFinite(parsed["recorded_at"]) ||
    (parsed["event_coverage"] !== "complete" &&
      parsed["event_coverage"] !== "sparse" &&
      parsed["event_coverage"] !== "none")
  ) {
    throw new Error(`analytics export ${row.exportId} does not match its outbox row`);
  }

  if (!isValidPayloadForKind(parsed, row.recordKind)) {
    throw new Error(
      `analytics export ${row.exportId} has incomplete or invalid ${row.recordKind} fields`,
    );
  }

  return parsed as unknown as AnalyticsOutboxPayload;
}

const commonPayloadKeys = [
  "schema_version",
  "record_kind",
  "export_id",
  "project_id",
  "session_id",
  "recorded_at",
  "event_coverage",
] as const;
const sessionPayloadKeys = [
  ...commonPayloadKeys,
  "org_id",
  "started_at",
  "ended_at",
  "duration_ms",
  "country",
  "region",
  "city",
  "device",
  "browser",
  "os",
  "entry_url",
  "url_count",
  "page_count",
  "analytics_version",
  "max_scroll_depth",
  "quick_backs",
  "interaction_time_ms",
  "activity_hist",
  "clicks",
  "event_count",
  "errors",
  "rages",
  "navs",
  "bytes",
  "segment_count",
  "flags",
  "manifest_key",
  "analytics_sidecar_key",
  "expires_at",
] as const;
const eventPayloadKeys = [
  ...commonPayloadKeys,
  "event_index",
  "event_time",
  "event_kind",
  "event_detail",
] as const;
const deletionPayloadKeys = [...commonPayloadKeys, "deleted_at", "delete_reason"] as const;

function isValidPayloadForKind(
  payload: Record<string, unknown>,
  kind: AnalyticsOutboxRow["recordKind"],
): boolean {
  if (
    !isPathId(payload["project_id"]) ||
    !isPathId(payload["session_id"]) ||
    !isNonEmptyText(payload["export_id"], 512) ||
    !isSafeTimestamp(payload["recorded_at"])
  ) {
    return false;
  }
  if (kind === "session") return isValidSessionPayload(payload);
  if (kind === "event") return isValidEventPayload(payload);
  return isValidDeletionPayload(payload);
}

function isValidSessionPayload(payload: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(payload, sessionPayloadKeys)) return false;
  const startedAt = payload["started_at"];
  const endedAt = payload["ended_at"];
  const durationMs = payload["duration_ms"];
  const coverage = payload["event_coverage"];
  const expectedSidecarKey = `p/${String(payload["project_id"])}/${String(payload["session_id"])}/analytics.ndjson`;
  const canonicalExportId = `session:${String(payload["project_id"])}:${String(payload["session_id"])}`;
  const recoveryExportId = `session:duration-recovery-v1:${String(payload["project_id"])}:${String(payload["session_id"])}`;

  return (
    (payload["export_id"] === canonicalExportId || payload["export_id"] === recoveryExportId) &&
    (coverage === "sparse" || coverage === "complete") &&
    isNonEmptyText(payload["org_id"], 200) &&
    isSafeTimestamp(startedAt) &&
    isSafeTimestamp(endedAt) &&
    endedAt >= startedAt &&
    isNonNegativeWholeNumber(durationMs) &&
    isNullableText(payload["country"], 512) &&
    isNullableText(payload["region"], 512) &&
    isNullableText(payload["city"], 512) &&
    isNullableText(payload["device"], 512) &&
    isNullableText(payload["browser"], 512) &&
    isNullableText(payload["os"], 512) &&
    isNullableText(payload["entry_url"], 2_048) &&
    isNonNegativeWholeNumber(payload["url_count"]) &&
    isNullableNonNegativeWholeNumber(payload["page_count"]) &&
    isNonNegativeWholeNumber(payload["analytics_version"]) &&
    isNullableWholeNumberInRange(payload["max_scroll_depth"], 0, 100) &&
    isNullableNonNegativeWholeNumber(payload["quick_backs"]) &&
    isNullableNonNegativeWholeNumber(payload["interaction_time_ms"]) &&
    isNullableText(payload["activity_hist"], 64) &&
    isNonNegativeWholeNumber(payload["clicks"]) &&
    isNonNegativeWholeNumber(payload["event_count"]) &&
    isNonNegativeWholeNumber(payload["errors"]) &&
    isNonNegativeWholeNumber(payload["rages"]) &&
    isNonNegativeWholeNumber(payload["navs"]) &&
    isNonNegativeWholeNumber(payload["bytes"]) &&
    isNonNegativeWholeNumber(payload["segment_count"]) &&
    isNonNegativeWholeNumber(payload["flags"]) &&
    isNonEmptyText(payload["manifest_key"], 512) &&
    (coverage === "complete"
      ? payload["analytics_sidecar_key"] === expectedSidecarKey
      : payload["analytics_sidecar_key"] === null) &&
    isSafeTimestamp(payload["expires_at"]) &&
    payload["expires_at"] >= endedAt
  );
}

function isValidEventPayload(payload: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(payload, eventPayloadKeys)) return false;
  const eventIndex = payload["event_index"];
  const eventTime = payload["event_time"];
  const eventKind = payload["event_kind"];
  const canonicalExportId = eventExportId(
    String(payload["project_id"]),
    String(payload["session_id"]),
    Number(eventIndex),
    Number(eventTime),
    String(eventKind),
  );
  const recoveryExportId = `event:duration-recovery-v1:${String(payload["project_id"])}:${String(payload["session_id"])}:${String(eventIndex)}:${String(eventTime)}:${String(eventKind)}`;

  return (
    payload["event_coverage"] === "sparse" &&
    isNonNegativeWholeNumber(eventIndex) &&
    isSafeTimestamp(eventTime) &&
    typeof eventKind === "string" &&
    allowedEventKinds.has(eventKind) &&
    (payload["export_id"] === canonicalExportId || payload["export_id"] === recoveryExportId) &&
    isNullableText(payload["event_detail"], MAX_EVENT_DETAIL_CHARS)
  );
}

function isValidDeletionPayload(payload: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(payload, deletionPayloadKeys)) return false;
  const canonicalExportId = `deletion:${String(payload["project_id"])}:${String(payload["session_id"])}`;
  const recoveryExportId = `deletion:duration-recovery-v1:${String(payload["project_id"])}:${String(payload["session_id"])}`;
  return (
    payload["event_coverage"] === "none" &&
    (payload["export_id"] === canonicalExportId || payload["export_id"] === recoveryExportId) &&
    isSafeTimestamp(payload["deleted_at"]) &&
    payload["deleted_at"] === payload["recorded_at"] &&
    isNonEmptyText(payload["delete_reason"], 200)
  );
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableNonNegativeWholeNumber(value: unknown): value is number | null {
  return value === null || isNonNegativeWholeNumber(value);
}

function isNullableWholeNumberInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum)
  );
}

function isNullableText(value: unknown, maximumLength: number): value is string | null {
  return value === null || (typeof value === "string" && value.length <= maximumLength);
}

function isNonEmptyText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function isPathId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function firstUnsentIndex(rows: readonly AnalyticsOutboxRow[]): number {
  const index = rows.findIndex((row) => row.sentAt === null);
  return index === -1 ? rows.length : index;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
