import { runR2SqlProjectQuery, type R2SqlSettings } from "./r2-sql-client.ts";
import {
  listAnalyticsDeletionV2JobsAwaitingVisibility,
  listUnsentAnalyticsDeletionV2Jobs,
  markAnalyticsDeletionV2Failed,
  markAnalyticsDeletionV2Sent,
  markAnalyticsDeletionV2Visible,
  readAnalyticsDeletionV2Counts,
  resetAnalyticsDeletionV2ForRetry,
  saveAnalyticsDeletionV2State,
  type AnalyticsDeletionV2Counts,
  type AnalyticsDeletionV2Job,
} from "./erasure-lifecycle.ts";
import { sqlText } from "./sql.ts";

export const ANALYTICS_DELETION_V2_SCHEMA_VERSION = 2;
export const ANALYTICS_DELETION_V2_TABLE = '"default"."analytics_deletions_v2"';

const DEFAULT_BATCH_SIZE = 90;
const MAX_BATCH_SIZE = 90;
const DEFAULT_VISIBILITY_DELAY_MS = 60_000;
const MAX_STORED_ERROR_CHARS = 500;

export interface AnalyticsDeletionV2Record extends Record<string, unknown> {
  schema_version: typeof ANALYTICS_DELETION_V2_SCHEMA_VERSION;
  record_kind: "deletion";
  export_id: string;
  export_sequence: number;
  project_id: string;
  session_id: string;
  recorded_at: number;
  deleted_at: number;
  delete_reason: string;
  session_started_at: number | null;
}

export interface AnalyticsDeletionV2Pipeline {
  send(records: readonly Record<string, unknown>[]): Promise<void>;
}

export interface AnalyticsDeletionV2Visibility {
  findVisibleExportIds(input: {
    projectId: string;
    records: readonly AnalyticsDeletionV2Record[];
  }): Promise<ReadonlySet<string> | readonly string[]>;
  proveTableExists(projectId: string): Promise<void>;
}

export interface MaintainAnalyticsDeletionV2Result {
  selected: number;
  sent: number;
  failed: number;
  checked: number;
  visible: number;
  missing: number;
  requiredJobs: number;
  visibleJobs: number;
  ready: boolean;
}

type DeletionV2JobRow = AnalyticsDeletionV2Job;
type DeletionV2CountRow = AnalyticsDeletionV2Counts;

interface DeletionV2WarehouseRow extends Record<string, unknown> {
  schema_version: number;
  record_kind: string;
  project_id: string;
  export_id: string;
  export_sequence: number;
  session_id: string;
  deleted_at: number;
  delete_reason: string;
  session_started_at: number | null;
}

/**
 * Backfills every retained deletion job into the versioned deletion table.
 *
 * Pipeline acceptance and R2 visibility are separate durable states. A stop
 * after acceptance resends the same stable export id. Runtime is allowed to
 * use v2 only after this function has proved every required job visible.
 */
export async function maintainAnalyticsDeletionV2(
  db: D1Database,
  pipeline: AnalyticsDeletionV2Pipeline,
  visibility: AnalyticsDeletionV2Visibility,
  options: { batchSize?: number; now?: number; visibilityDelayMs?: number } = {},
): Promise<MaintainAnalyticsDeletionV2Result> {
  const batchSize = safeBatchSize(options.batchSize);
  const now = safeTime(options.now ?? Date.now());
  const visibilityDelayMs = safeVisibilityDelay(options.visibilityDelayMs);
  let selected = 0;
  let sent = 0;
  let failed = 0;
  let checked = 0;
  let visible = 0;
  let missing = 0;

  const unsent = await listUnsentAnalyticsDeletionV2Jobs(db, batchSize);
  selected = unsent.length;

  const validUnsent: DeletionV2JobRow[] = [];
  const records: AnalyticsDeletionV2Record[] = [];
  for (const job of unsent) {
    try {
      records.push(buildAnalyticsDeletionV2Record(job));
      validUnsent.push(job);
    } catch (error) {
      await markAnalyticsDeletionV2Failed(db, [job], storedError(error));
      failed += 1;
    }
  }

  if (records.length > 0) {
    try {
      await pipeline.send(records);
      await markAnalyticsDeletionV2Sent(db, validUnsent, now);
      sent = records.length;
    } catch (error) {
      const message = storedError(error);
      await markAnalyticsDeletionV2Failed(db, validUnsent, message);
      const counts = await readAnalyticsDeletionV2Counts(db);
      await saveAnalyticsDeletionV2State(db, counts, now, message, false);
      throw new Error(`Analytics deletion v2 delivery failed: ${message}`, { cause: error });
    }
  }

  const visibilityCutoff = Math.max(0, now - visibilityDelayMs);
  const waiting = await listAnalyticsDeletionV2JobsAwaitingVisibility(
    db,
    visibilityCutoff,
    batchSize,
  );
  checked = waiting.length;

  for (const projectJobs of groupJobsByProject(waiting)) {
    const validWaiting: DeletionV2JobRow[] = [];
    const expectedRecords: AnalyticsDeletionV2Record[] = [];
    for (const job of projectJobs) {
      try {
        expectedRecords.push(buildAnalyticsDeletionV2Record(job));
        validWaiting.push(job);
      } catch (error) {
        await resetAnalyticsDeletionV2ForRetry(db, [job]);
        await markAnalyticsDeletionV2Failed(db, [job], storedError(error));
        failed += 1;
      }
    }
    if (expectedRecords.length === 0) continue;

    let visibleIds: ReadonlySet<string>;
    try {
      const answer = await visibility.findVisibleExportIds({
        projectId: validWaiting[0]?.projectId ?? "",
        records: expectedRecords,
      });
      visibleIds = answer instanceof Set ? answer : new Set(answer);
    } catch (error) {
      const message = storedError(error);
      const counts = await readAnalyticsDeletionV2Counts(db);
      await saveAnalyticsDeletionV2State(db, counts, now, message, false);
      throw new Error(`Analytics deletion v2 visibility failed: ${message}`, { cause: error });
    }

    const found: DeletionV2JobRow[] = [];
    const notFound: DeletionV2JobRow[] = [];
    for (const job of validWaiting) {
      if (visibleIds.has(deletionV2ExportId(job.projectId, job.sessionId))) found.push(job);
      else notFound.push(job);
    }
    await markAnalyticsDeletionV2Visible(db, found, now);
    await resetAnalyticsDeletionV2ForRetry(db, notFound);
    visible += found.length;
    missing += notFound.length;
  }

  const counts = await readAnalyticsDeletionV2Counts(db);
  const ready = counts.requiredJobs === counts.visibleJobs;
  let stateError = deletionV2StateError(failed, missing, counts);

  if (ready) {
    try {
      // This probe matters when there are no historical jobs. It prevents an
      // empty D1 database from approving a table that was never provisioned.
      await visibility.proveTableExists("deletion-v2-readiness");
    } catch (error) {
      stateError = storedError(error);
      await saveAnalyticsDeletionV2State(db, counts, now, stateError, false);
      throw new Error(`Analytics deletion v2 table check failed: ${stateError}`, { cause: error });
    }
  }

  await saveAnalyticsDeletionV2State(db, counts, now, stateError, ready);
  return {
    selected,
    sent,
    failed,
    checked,
    visible,
    missing,
    requiredJobs: counts.requiredJobs,
    visibleJobs: counts.visibleJobs,
    ready,
  };
}

export function buildAnalyticsDeletionV2Record(job: DeletionV2JobRow): AnalyticsDeletionV2Record {
  if (!safeId(job.projectId) || !safeId(job.sessionId)) {
    throw new Error("Analytics deletion v2 has an invalid project or session id.");
  }
  if (!Number.isSafeInteger(job.requestedAt) || job.requestedAt <= 0) {
    throw new Error("Analytics deletion v2 has an invalid deletion time.");
  }
  if (!Number.isSafeInteger(job.exportSequence) || job.exportSequence <= 0) {
    throw new Error("Analytics deletion v2 has an invalid export sequence.");
  }
  if (
    job.sessionStartedAt !== null &&
    (!Number.isSafeInteger(job.sessionStartedAt) ||
      job.sessionStartedAt < 0 ||
      job.sessionStartedAt > job.requestedAt)
  ) {
    throw new Error("Analytics deletion v2 has an invalid session start time.");
  }
  if (job.deleteReason.length === 0 || job.deleteReason.length > 200) {
    throw new Error("Analytics deletion v2 has an invalid reason.");
  }

  return {
    schema_version: ANALYTICS_DELETION_V2_SCHEMA_VERSION,
    record_kind: "deletion",
    export_id: deletionV2ExportId(job.projectId, job.sessionId),
    export_sequence: job.exportSequence,
    project_id: job.projectId,
    session_id: job.sessionId,
    recorded_at: job.requestedAt,
    deleted_at: job.requestedAt,
    delete_reason: job.deleteReason,
    session_started_at: job.sessionStartedAt,
  };
}

export function deletionV2ExportId(projectId: string, sessionId: string): string {
  return `deletion-v2:${projectId}:${sessionId}`;
}

export function buildAnalyticsDeletionV2VisibilityQuery(input: {
  projectId: string;
  records: readonly AnalyticsDeletionV2Record[];
}): string {
  if (input.records.length < 1 || input.records.length > MAX_BATCH_SIZE) {
    throw new Error("Analytics deletion v2 visibility needs between 1 and 90 records.");
  }
  if (input.records.some((record) => record.project_id !== input.projectId)) {
    throw new Error("Analytics deletion v2 visibility cannot mix projects.");
  }
  const project = sqlText(input.projectId);
  const ids = input.records.map((record) => sqlText(record.export_id)).join(", ");

  return `WITH scoped_deletions AS (
  SELECT
    d.schema_version,
    d.record_kind,
    d.project_id,
    d.export_id,
    d.export_sequence,
    d.session_id,
    d.recorded_at,
    d.deleted_at,
    d.delete_reason,
    d.session_started_at,
    ROW_NUMBER() OVER (
      PARTITION BY d.project_id, d.export_id
      ORDER BY d.export_sequence DESC, d.recorded_at DESC
    ) AS retry_rank
  FROM ${ANALYTICS_DELETION_V2_TABLE} d
  WHERE d.project_id = ${project}
    AND d.export_id IN (${ids})
)
SELECT
  schema_version,
  record_kind,
  project_id,
  export_id,
  export_sequence,
  session_id,
  deleted_at,
  delete_reason,
  session_started_at
FROM scoped_deletions
WHERE retry_rank = 1`;
}

export function createAnalyticsDeletionV2Visibility(
  settings: R2SqlSettings,
): AnalyticsDeletionV2Visibility {
  return {
    async findVisibleExportIds(input) {
      const expected = new Map(input.records.map((record) => [record.export_id, record]));
      const result = await runR2SqlProjectQuery<DeletionV2WarehouseRow>(
        settings,
        input.projectId,
        buildAnalyticsDeletionV2VisibilityQuery(input),
      );
      const visible = new Set<string>();
      for (const row of result.rows) {
        const wanted = expected.get(row.export_id);
        if (wanted === undefined) {
          throw new Error("Analytics deletion v2 visibility returned an unknown export id.");
        }
        if (!sameDeletionV2Record(wanted, row)) continue;
        visible.add(row.export_id);
      }
      return visible;
    },
    async proveTableExists(projectId) {
      await runR2SqlProjectQuery<Record<string, unknown>>(
        settings,
        projectId,
        `SELECT project_id, export_id FROM ${ANALYTICS_DELETION_V2_TABLE} WHERE 1 = 0`,
      );
    },
  };
}

function groupJobsByProject(jobs: readonly DeletionV2JobRow[]): DeletionV2JobRow[][] {
  const groups = new Map<string, DeletionV2JobRow[]>();
  for (const job of jobs) {
    const group = groups.get(job.projectId) ?? [];
    group.push(job);
    groups.set(job.projectId, group);
  }
  return [...groups.values()];
}

function deletionV2StateError(
  failed: number,
  missing: number,
  counts: DeletionV2CountRow,
): string | null {
  if (failed > 0) {
    return `${String(failed)} analytics deletion v2 record${failed === 1 ? " is" : "s are"} invalid`;
  }
  const notVisible = missing > 0 ? missing : counts.requiredJobs - counts.visibleJobs;
  return notVisible === 0
    ? null
    : `${String(notVisible)} analytics deletion v2 record${notVisible === 1 ? " is" : "s are"} not visible yet`;
}

function sameDeletionV2Record(
  expected: AnalyticsDeletionV2Record,
  row: DeletionV2WarehouseRow,
): boolean {
  return (
    row.schema_version === expected.schema_version &&
    row.record_kind === expected.record_kind &&
    row.project_id === expected.project_id &&
    row.export_id === expected.export_id &&
    row.export_sequence === expected.export_sequence &&
    row.session_id === expected.session_id &&
    row.deleted_at === expected.deleted_at &&
    row.delete_reason === expected.delete_reason &&
    row.session_started_at === expected.session_started_at
  );
}

function safeBatchSize(value: number | undefined): number {
  const size = value ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BATCH_SIZE) {
    throw new Error("Analytics deletion v2 batch size must be from 1 to 90.");
  }
  return size;
}

function safeVisibilityDelay(value: number | undefined): number {
  const delay = value ?? DEFAULT_VISIBILITY_DELAY_MS;
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 24 * 60 * 60 * 1_000) {
    throw new Error("Analytics deletion v2 visibility delay is invalid.");
  }
  return delay;
}

function safeTime(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Analytics deletion v2 has an invalid maintenance time.");
  }
  return value;
}

function safeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function storedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_STORED_ERROR_CHARS);
}
