import type { FinalizeMessage } from "@orange-replay/shared";
import {
  durationMsFromTimes,
  expiresAtFromEndedAt,
  truncateEventDetail,
} from "../consumer/helpers.ts";

export const ANALYTICS_RECORD_SCHEMA_VERSION = 1;
export const MAX_ANALYTICS_RECORD_BYTES = 32 * 1024;

const MAX_DIMENSION_CHARS = 512;
const MAX_MANIFEST_KEY_CHARS = 512;
const MAX_DELETE_REASON_CHARS = 200;
const utf8Encoder = new TextEncoder();

export type AnalyticsRecordKind = "session" | "event" | "deletion";
export type AnalyticsEventCoverage = "complete" | "sparse" | "none";

interface AnalyticsRecordBase {
  schema_version: typeof ANALYTICS_RECORD_SCHEMA_VERSION;
  record_kind: AnalyticsRecordKind;
  export_id: string;
  project_id: string;
  session_id: string;
  recorded_at: number;
  event_coverage: AnalyticsEventCoverage;
}

export interface AnalyticsSessionRecord extends AnalyticsRecordBase {
  record_kind: "session";
  org_id: string;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  country: string | null;
  region: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  entry_url: string | null;
  url_count: number;
  page_count: number | null;
  analytics_version: number;
  max_scroll_depth: number | null;
  quick_backs: number | null;
  interaction_time_ms: number | null;
  activity_hist: string | null;
  clicks: number;
  event_count: number;
  errors: number;
  rages: number;
  navs: number;
  bytes: number;
  segment_count: number;
  flags: number;
  manifest_key: string;
  analytics_sidecar_key: string | null;
  expires_at: number;
}

export interface AnalyticsEventRecord extends AnalyticsRecordBase {
  record_kind: "event";
  event_index: number;
  event_time: number;
  event_kind: string;
  event_detail: string | null;
}

export interface AnalyticsDeletionRecord extends AnalyticsRecordBase {
  record_kind: "deletion";
  deleted_at: number;
  delete_reason: string;
}

export type AnalyticsOutboxPayload =
  | AnalyticsSessionRecord
  | AnalyticsEventRecord
  | AnalyticsDeletionRecord;

export type AnalyticsWarehouseRecord = AnalyticsOutboxPayload & {
  export_sequence: number;
};

export interface SerializedAnalyticsRecord {
  exportId: string;
  projectId: string;
  sessionId: string;
  recordKind: AnalyticsRecordKind;
  payloadJson: string;
}

export interface FinalizeAnalyticsRecords {
  session: AnalyticsSessionRecord;
  events: AnalyticsEventRecord[];
  serialized: SerializedAnalyticsRecord[];
}

export function buildFinalizeAnalyticsRecords(message: FinalizeMessage): FinalizeAnalyticsRecords {
  const session = buildSessionRecord(message);
  const events = buildEventRecords(message);
  // Complete sidecar events are exported by the sidecar drain. Keep the
  // sparse rows for D1 compatibility, but do not also queue them here.
  // Sparse events must have lower export sequences than their session. That
  // way a watermark can never expose the session before all of its available
  // event evidence is visible.
  const records: AnalyticsOutboxPayload[] =
    message.analyticsSidecarKey === undefined ? [...events, session] : [session];

  return {
    session,
    events,
    serialized: records.map(serializeAnalyticsPayload),
  };
}

export function buildSessionRecord(message: FinalizeMessage): AnalyticsSessionRecord {
  const record: AnalyticsSessionRecord = {
    schema_version: ANALYTICS_RECORD_SCHEMA_VERSION,
    record_kind: "session",
    export_id: sessionExportId(message.projectId, message.sessionId),
    project_id: message.projectId,
    session_id: message.sessionId,
    recorded_at: message.endedAt,
    event_coverage: message.analyticsSidecarKey === undefined ? "sparse" : "complete",
    org_id: message.orgId,
    started_at: message.startedAt,
    ended_at: message.endedAt,
    // Recorded event-time span when the DO provided it; the server-arrival
    // span only remains as the fallback for pre-upgrade queue messages.
    duration_ms: message.durationMs ?? durationMsFromTimes(message.startedAt, message.endedAt),
    country: boundedOptionalText(message.attrs.country, MAX_DIMENSION_CHARS),
    region: boundedOptionalText(message.attrs.region, MAX_DIMENSION_CHARS),
    city: boundedOptionalText(message.attrs.city, MAX_DIMENSION_CHARS),
    device: boundedOptionalText(message.attrs.device, MAX_DIMENSION_CHARS),
    browser: boundedOptionalText(message.attrs.browser, MAX_DIMENSION_CHARS),
    os: boundedOptionalText(message.attrs.os, MAX_DIMENSION_CHARS),
    entry_url: boundedOptionalText(message.attrs.entryUrl, 2_048),
    url_count: message.attrs.urlCount ?? 0,
    page_count: message.attrs.pageCount ?? null,
    analytics_version: message.analyticsVersion ?? 0,
    max_scroll_depth: message.insights?.maxScrollDepth ?? null,
    quick_backs: message.insights?.quickBacks ?? null,
    interaction_time_ms: message.insights?.interactionTimeMs ?? null,
    activity_hist: boundedOptionalText(message.insights?.activityHist ?? undefined, 64),
    clicks: message.counts.clicks,
    event_count: message.counts.events,
    errors: message.counts.errors,
    rages: message.counts.rages,
    navs: message.counts.navs,
    bytes: message.bytes,
    segment_count: message.segments,
    flags: message.flags,
    manifest_key: boundedText(message.manifestKey, MAX_MANIFEST_KEY_CHARS),
    analytics_sidecar_key: boundedOptionalText(message.analyticsSidecarKey, MAX_MANIFEST_KEY_CHARS),
    expires_at: expiresAtFromEndedAt(message.endedAt, message.retentionDays),
  };

  assertRecordFits(record);
  return record;
}

export function buildEventRecords(message: FinalizeMessage): AnalyticsEventRecord[] {
  const eventsByD1Key = new Map<string, FinalizeMessage["events"][number]>();
  const records: AnalyticsEventRecord[] = [];

  for (const event of message.events) {
    // session_events has this exact primary key. Keeping the first row here
    // makes the D1 sparse index and the warehouse export agree.
    const d1Key = `${String(event.t)}\u0000${event.k}`;
    if (!eventsByD1Key.has(d1Key)) eventsByD1Key.set(d1Key, event);
  }

  const canonicalEvents = [...eventsByD1Key.values()].toSorted(
    (left, right) => left.t - right.t || left.k.localeCompare(right.k),
  );

  for (const [eventIndex, event] of canonicalEvents.entries()) {
    const record: AnalyticsEventRecord = {
      schema_version: ANALYTICS_RECORD_SCHEMA_VERSION,
      record_kind: "event",
      export_id: eventExportId(message.projectId, message.sessionId, eventIndex, event.t, event.k),
      project_id: message.projectId,
      session_id: message.sessionId,
      recorded_at: event.t,
      event_coverage: "sparse",
      event_index: eventIndex,
      event_time: event.t,
      event_kind: event.k,
      event_detail: truncateEventDetail(event.d),
    };

    assertRecordFits(record);
    records.push(record);
  }

  return records;
}

export function buildDeletionRecord(input: {
  projectId: string;
  sessionId: string;
  deletedAt: number;
  reason: string;
}): AnalyticsDeletionRecord {
  const record: AnalyticsDeletionRecord = {
    schema_version: ANALYTICS_RECORD_SCHEMA_VERSION,
    record_kind: "deletion",
    export_id: deletionExportId(input.projectId, input.sessionId),
    project_id: input.projectId,
    session_id: input.sessionId,
    recorded_at: input.deletedAt,
    event_coverage: "none",
    deleted_at: input.deletedAt,
    delete_reason: boundedText(input.reason, MAX_DELETE_REASON_CHARS),
  };

  assertRecordFits(record);
  return record;
}

export function serializeAnalyticsPayload(
  payload: AnalyticsOutboxPayload,
): SerializedAnalyticsRecord {
  const payloadJson = JSON.stringify(payload);
  assertSerializedRecordFits(payloadJson, payload.export_id);

  return {
    exportId: payload.export_id,
    projectId: payload.project_id,
    sessionId: payload.session_id,
    recordKind: payload.record_kind,
    payloadJson,
  };
}

export function addExportSequence(
  payload: AnalyticsOutboxPayload,
  exportSequence: number,
): AnalyticsWarehouseRecord {
  if (!Number.isSafeInteger(exportSequence) || exportSequence <= 0) {
    throw new Error("analytics export sequence must be a positive integer");
  }

  const record = { ...payload, export_sequence: exportSequence };
  assertRecordFits(record);
  return record;
}

export function sessionExportId(projectId: string, sessionId: string): string {
  return `session:${projectId}:${sessionId}`;
}

export function eventExportId(
  projectId: string,
  sessionId: string,
  eventIndex: number,
  eventTime: number,
  eventKind: string,
): string {
  return `event:${projectId}:${sessionId}:${eventIndex}:${String(eventTime)}:${eventKind}`;
}

export function deletionExportId(projectId: string, sessionId: string): string {
  return `deletion:${projectId}:${sessionId}`;
}

function boundedOptionalText(value: string | undefined, limit: number): string | null {
  return value === undefined ? null : boundedText(value, limit);
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function assertRecordFits(record: object): void {
  const exportId = "export_id" in record ? String(record.export_id) : "unknown";
  assertSerializedRecordFits(JSON.stringify(record), exportId);
}

function assertSerializedRecordFits(payloadJson: string, exportId: string): void {
  const bytes = utf8Encoder.encode(payloadJson).byteLength;
  if (bytes > MAX_ANALYTICS_RECORD_BYTES) {
    throw new Error(`analytics export ${exportId} is larger than 32 KiB`);
  }
}
