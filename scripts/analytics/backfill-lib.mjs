import path from "node:path";

export const ANALYTICS_OUTBOX_PAYLOAD_MAX_BYTES = 32 * 1024;
// D1 rejects SQL statements at 100,000 bytes. Keep 10,000 bytes free for
// command wrapping and future fixed SQL text.
export const D1_OUTBOX_INSERT_SQL_MAX_BYTES = 90_000;
export const D1_BACKFILL_READ_SQL_MAX_BYTES = 90_000;

const MAX_EVENT_DETAIL_CHARS = 200;
const MAX_DIMENSION_CHARS = 512;
const MAX_ENTRY_URL_CHARS = 2_048;
const MAX_ACTIVITY_HIST_CHARS = 64;
const MAX_ORG_ID_CHARS = 200;
const MAX_MANIFEST_KEY_CHARS = 512;
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

export const sessionColumns = [
  "session_id",
  "project_id",
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
  "errors",
  "rages",
  "navs",
  "bytes",
  "segment_count",
  "flags",
  "manifest_key",
  "expires_at",
];

export function parseBackfillArguments(argumentsList, defaults) {
  const options = {
    apply: false,
    configPath: undefined,
    database: undefined,
    inventoryPath: undefined,
    now: Date.now(),
    pageSize: 100,
    persistTo: undefined,
    recordingsBucket: undefined,
    reportPath: undefined,
    source: undefined,
    wranglerEnvironment: undefined,
    ...defaults,
  };
  const valueOptions = new Map([
    ["--config", "configPath"],
    ["--database", "database"],
    ["--env", "wranglerEnvironment"],
    ["--inventory", "inventoryPath"],
    ["--persist-to", "persistTo"],
    ["--recordings-bucket", "recordingsBucket"],
    ["--report", "reportPath"],
    ["--source", "source"],
  ]);

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--apply") {
      options.apply = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--now" || argument === "--page-size") {
      const rawValue = argumentsList[index + 1];
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error(`${argument} needs a whole number.`);
      }
      const numberValue = Number(rawValue);
      if (!Number.isSafeInteger(numberValue) || numberValue < 1) {
        throw new Error(`${argument} needs a positive whole number.`);
      }
      if (argument === "--now") options.now = numberValue;
      else options.pageSize = numberValue;
      index += 1;
      continue;
    }
    const target = valueOptions.get(argument);
    if (target !== undefined) {
      const value = argumentsList[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} needs a value.`);
      }
      options[target] =
        target.endsWith("Path") || target === "persistTo" ? path.resolve(value) : value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown backfill option: ${argument}`);
  }

  if (options.help) return options;
  if (options.source !== "local" && options.source !== "production") {
    throw new Error("--source must be local or production. It prevents mixing their inventories.");
  }
  if (!isSimpleResourceName(options.database)) {
    throw new Error("--database must be a valid D1 database name.");
  }
  if (!isSimpleResourceName(options.recordingsBucket)) {
    throw new Error("--recordings-bucket must be a valid R2 bucket name.");
  }
  if (typeof options.inventoryPath !== "string") {
    throw new Error("--inventory is required so missing and orphan manifests can be proved.");
  }
  if (options.pageSize > 500) {
    throw new Error("--page-size cannot be more than 500.");
  }
  if (options.source === "production" && options.persistTo !== undefined) {
    throw new Error("--persist-to is only allowed with --source local.");
  }
  return options;
}

export function parseManifestInventory(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  let values;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error("The manifest inventory is not valid JSON.", { cause: error });
    }
    values = Array.isArray(parsed) ? parsed : parsed.objects;
    if (!Array.isArray(values)) {
      throw new Error("The manifest inventory JSON needs an array or an objects array.");
    }
  } else {
    values = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  }

  const keys = values.map((value, index) => {
    const key = typeof value === "string" ? value : value?.key;
    if (typeof key !== "string" || key.length === 0 || key.length > 1_024 || key.includes("\0")) {
      throw new Error(`Manifest inventory item ${index + 1} has an invalid key.`);
    }
    return key;
  });
  return [...new Set(keys)].sort((left, right) => left.localeCompare(right));
}

export function manifestIdentityFromKey(key) {
  const match = /^p\/([^/]+)\/([^/]+)\/manifest\.json$/.exec(key);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { projectId: match[1], sessionId: match[2] };
}

export function validateManifestText(key, text, inventoryKeys) {
  const identity = manifestIdentityFromKey(key);
  if (identity === undefined) return { ok: false, reason: "invalid_manifest_key" };
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    manifest.v !== 1 ||
    manifest.projectId !== identity.projectId ||
    manifest.sessionId !== identity.sessionId ||
    !Array.isArray(manifest.segments) ||
    !Array.isArray(manifest.timeline)
  ) {
    return { ok: false, reason: "invalid_manifest_shape" };
  }
  const expectedSegmentPattern = new RegExp(
    `^p/${escapePattern(identity.projectId)}/${escapePattern(identity.sessionId)}/seg-[0-9]{6}\\.ors$`,
  );
  const segmentKeys = [];
  for (const segment of manifest.segments) {
    const segmentKey = segment?.key;
    if (typeof segmentKey !== "string" || !expectedSegmentPattern.test(segmentKey)) {
      return { ok: false, reason: "invalid_segment_key" };
    }
    segmentKeys.push(segmentKey);
  }
  if (new Set(segmentKeys).size !== segmentKeys.length) {
    return { ok: false, reason: "duplicate_segment_key" };
  }
  if (inventoryKeys !== undefined) {
    const missingSegments = segmentKeys.filter((segmentKey) => !inventoryKeys.has(segmentKey));
    if (missingSegments.length > 0) {
      return {
        ok: false,
        reason: "missing_segment_objects",
        missingSegmentCount: missingSegments.length,
      };
    }
  }
  return { ok: true };
}

export function classifySession(session, inventoryKeys, manifestChecks, now) {
  if (Number(session.is_deleted) > 0) return "deleted";
  if (asSafeInteger(session.expires_at, "expires_at") < now) return "expired";
  if (!inventoryKeys.has(session.manifest_key)) return "missing";
  if (manifestChecks.get(session.manifest_key)?.ok !== true) return "invalid";
  return "migrated";
}

export function usesDefaultAnalyticsCatalog(jurisdiction) {
  return jurisdiction === null;
}

export function buildSessionOutboxRecord(session, eventCount = 0) {
  const projectId = requireId(session.project_id, "project_id");
  const sessionId = requireId(session.session_id, "session_id");
  const startedAt = nonNegativeSafeInteger(session.started_at, "started_at");
  const endedAt = nonNegativeSafeInteger(session.ended_at, "ended_at");
  if (endedAt < startedAt) throw new Error("ended_at cannot be before started_at.");
  const durationMs = nonNegativeSafeInteger(session.duration_ms, "duration_ms");
  if (durationMs !== endedAt - startedAt) {
    throw new Error("duration_ms must equal ended_at minus started_at.");
  }
  const expiresAt = nonNegativeSafeInteger(session.expires_at, "expires_at");
  if (expiresAt < endedAt) throw new Error("expires_at cannot be before ended_at.");
  const payload = {
    schema_version: 1,
    record_kind: "session",
    export_id: `session:${projectId}:${sessionId}`,
    project_id: projectId,
    session_id: sessionId,
    recorded_at: endedAt,
    org_id: requireBoundedText(session.org_id, "org_id", MAX_ORG_ID_CHARS),
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    country: nullableBoundedText(session.country, "country", MAX_DIMENSION_CHARS),
    region: nullableBoundedText(session.region, "region", MAX_DIMENSION_CHARS),
    city: nullableBoundedText(session.city, "city", MAX_DIMENSION_CHARS),
    device: nullableBoundedText(session.device, "device", MAX_DIMENSION_CHARS),
    browser: nullableBoundedText(session.browser, "browser", MAX_DIMENSION_CHARS),
    os: nullableBoundedText(session.os, "os", MAX_DIMENSION_CHARS),
    entry_url: nullableBoundedText(session.entry_url, "entry_url", MAX_ENTRY_URL_CHARS),
    url_count: nonNegativeSafeInteger(session.url_count, "url_count"),
    page_count: nullableNonNegativeSafeInteger(session.page_count, "page_count"),
    analytics_version: nonNegativeSafeInteger(session.analytics_version, "analytics_version"),
    max_scroll_depth: nullableSafeIntegerInRange(
      session.max_scroll_depth,
      "max_scroll_depth",
      0,
      100,
    ),
    quick_backs: nullableNonNegativeSafeInteger(session.quick_backs, "quick_backs"),
    interaction_time_ms: nullableNonNegativeSafeInteger(
      session.interaction_time_ms,
      "interaction_time_ms",
    ),
    activity_hist: nullableBoundedText(
      session.activity_hist,
      "activity_hist",
      MAX_ACTIVITY_HIST_CHARS,
    ),
    clicks: nonNegativeSafeInteger(session.clicks, "clicks"),
    errors: nonNegativeSafeInteger(session.errors, "errors"),
    rages: nonNegativeSafeInteger(session.rages, "rages"),
    navs: nonNegativeSafeInteger(session.navs, "navs"),
    bytes: nonNegativeSafeInteger(session.bytes, "bytes"),
    segment_count: nonNegativeSafeInteger(session.segment_count, "segment_count"),
    flags: nonNegativeSafeInteger(session.flags, "flags"),
    manifest_key: requireBoundedText(session.manifest_key, "manifest_key", MAX_MANIFEST_KEY_CHARS),
    analytics_sidecar_key: null,
    expires_at: expiresAt,
    event_coverage: "sparse",
    event_count: nonNegativeSafeInteger(eventCount, "event_count"),
  };
  return outboxRecord(payload);
}

export function buildEventOutboxRecords(session, events) {
  const projectId = requireId(session.project_id, "project_id");
  const sessionId = requireId(session.session_id, "session_id");
  return [...events]
    .sort(
      (left, right) =>
        Number(left.t) - Number(right.t) || String(left.kind).localeCompare(String(right.kind)),
    )
    .map((event, index) => {
      const eventTime = nonNegativeSafeInteger(event.t, "event_time");
      const eventKind = requireEventKind(event.kind);
      const payload = {
        schema_version: 1,
        record_kind: "event",
        export_id: `event:${projectId}:${sessionId}:${index}:${eventTime}:${eventKind}`,
        project_id: projectId,
        session_id: sessionId,
        recorded_at: eventTime,
        event_coverage: "sparse",
        event_index: index,
        event_time: eventTime,
        event_kind: eventKind,
        event_detail: nullableBoundedText(event.detail, "event_detail", MAX_EVENT_DETAIL_CHARS),
      };
      return outboxRecord(payload);
    });
}

export function buildOutboxInsertSql(records, createdAt) {
  if (!Array.isArray(records) || records.length === 0) return undefined;
  const timestamp = asSafeInteger(createdAt, "created_at");
  const values = records.map((record, index) => {
    const payloadJson = serializeOutboxPayload(record);
    return `(${index}, ${sqlString(record.exportId)}, ${sqlString(record.projectId)}, ${sqlString(
      record.sessionId,
    )}, ${sqlString(record.recordKind)}, ${sqlString(payloadJson)}, ${timestamp})`;
  });
  return `WITH incoming(record_order, export_id, project_id, session_id, record_kind, payload_json, created_at) AS (
      VALUES ${values.join(",\n")}
    )
    INSERT OR IGNORE INTO analytics_export_outbox
    (export_id, project_id, session_id, record_kind, payload_json, created_at)
    SELECT export_id, project_id, session_id, record_kind, payload_json, created_at
    FROM incoming
    WHERE NOT EXISTS (
      SELECT 1 FROM analytics_export_ledger ledger WHERE ledger.export_id = incoming.export_id
    )
      AND EXISTS (
        SELECT 1
        FROM projects project
        WHERE project.id = incoming.project_id
          AND project.jurisdiction IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM session_deletions deletion
        WHERE deletion.project_id = incoming.project_id
          AND deletion.session_id = incoming.session_id
      )
    ORDER BY record_order;`;
}

export function buildOutboxInsertBatches(
  records,
  createdAt,
  sqlByteLimit = D1_OUTBOX_INSERT_SQL_MAX_BYTES,
) {
  if (!Array.isArray(records)) throw new Error("Analytics outbox records must be an array.");
  if (
    !Number.isSafeInteger(sqlByteLimit) ||
    sqlByteLimit < 1 ||
    sqlByteLimit > D1_OUTBOX_INSERT_SQL_MAX_BYTES
  ) {
    throw new Error(
      `Analytics outbox SQL byte limit must be between 1 and ${D1_OUTBOX_INSERT_SQL_MAX_BYTES}.`,
    );
  }

  const batches = [];
  let currentRecords = [];
  for (const record of records) {
    // Validate the row before measuring the SQL. This also gives an exact and
    // useful 32 KiB error instead of a misleading D1 statement-size error.
    serializeOutboxPayload(record);
    const candidateRecords = [...currentRecords, record];
    const candidateSql = buildOutboxInsertSql(candidateRecords, createdAt);
    if (candidateSql === undefined) continue;
    const candidateBytes = utf8Bytes(candidateSql);
    if (candidateBytes <= sqlByteLimit) {
      currentRecords = candidateRecords;
      continue;
    }

    if (currentRecords.length === 0) {
      throw new Error(`Analytics export ${record.exportId} cannot fit in one safe D1 statement.`);
    }
    const sql = buildOutboxInsertSql(currentRecords, createdAt);
    if (sql === undefined)
      throw new Error("Analytics outbox batching produced an empty statement.");
    batches.push({ records: currentRecords, sql, sqlBytes: utf8Bytes(sql) });
    currentRecords = [record];

    const singleSql = buildOutboxInsertSql(currentRecords, createdAt);
    if (singleSql === undefined || utf8Bytes(singleSql) > sqlByteLimit) {
      throw new Error(`Analytics export ${record.exportId} cannot fit in one safe D1 statement.`);
    }
  }

  if (currentRecords.length > 0) {
    const sql = buildOutboxInsertSql(currentRecords, createdAt);
    if (sql === undefined)
      throw new Error("Analytics outbox batching produced an empty statement.");
    batches.push({ records: currentRecords, sql, sqlBytes: utf8Bytes(sql) });
  }
  return batches;
}

export function buildSessionEventsQueries(sessions, sqlByteLimit = D1_BACKFILL_READ_SQL_MAX_BYTES) {
  if (!Array.isArray(sessions)) throw new Error("Backfill sessions must be an array.");
  if (
    !Number.isSafeInteger(sqlByteLimit) ||
    sqlByteLimit < 1 ||
    sqlByteLimit > D1_BACKFILL_READ_SQL_MAX_BYTES
  ) {
    throw new Error(
      `Backfill read SQL byte limit must be between 1 and ${D1_BACKFILL_READ_SQL_MAX_BYTES}.`,
    );
  }

  const batches = [];
  let currentSessions = [];
  for (const session of sessions) {
    const candidateSessions = [...currentSessions, session];
    const candidateSql = sessionEventsSql(candidateSessions);
    const candidateBytes = utf8Bytes(candidateSql);
    if (candidateBytes <= sqlByteLimit) {
      currentSessions = candidateSessions;
      continue;
    }
    if (currentSessions.length === 0) {
      throw new Error("One session cannot fit in a safe D1 event read statement.");
    }
    const sql = sessionEventsSql(currentSessions);
    batches.push({ sessions: currentSessions, sql, sqlBytes: utf8Bytes(sql) });
    currentSessions = [session];
    const singleSql = sessionEventsSql(currentSessions);
    if (utf8Bytes(singleSql) > sqlByteLimit) {
      throw new Error("One session cannot fit in a safe D1 event read statement.");
    }
  }

  if (currentSessions.length > 0) {
    const sql = sessionEventsSql(currentSessions);
    batches.push({ sessions: currentSessions, sql, sqlBytes: utf8Bytes(sql) });
  }
  return batches;
}

export function buildBackfillCompletionSql(input) {
  const projectId = requireId(input.projectId, "project_id");
  const sourceSessionCount = asSafeInteger(input.sourceSessionCount, "source_session_count");
  if (sourceSessionCount < 0) throw new Error("source_session_count cannot be negative.");
  const activeDeletionCount = asSafeInteger(input.activeDeletionCount, "active_deletion_count");
  if (activeDeletionCount < 0) throw new Error("active_deletion_count cannot be negative.");
  const sourceCutoffMs = positiveSafeInteger(input.sourceCutoffMs, "source_cutoff_ms");
  const requiredSequence = asSafeInteger(input.requiredSequence, "required_sequence");
  if (requiredSequence < 0) throw new Error("required_sequence cannot be negative.");
  const completedAt = positiveSafeInteger(input.completedAt, "completed_at");
  const reportId = requireText(input.reportId, "report_id");
  if (reportId.length === 0 || reportId.length > 200) {
    throw new Error("report_id must be between 1 and 200 characters.");
  }

  return `INSERT INTO analytics_backfill_completions (
      project_id, source_session_count, source_cutoff_ms, required_sequence, report_id, completed_at
    ) SELECT
      ${sqlString(projectId)}, ${sourceSessionCount}, ${sourceCutoffMs}, ${requiredSequence}, ${sqlString(reportId)}, ${completedAt}
    WHERE EXISTS (
      SELECT 1 FROM projects project
      WHERE project.id = ${sqlString(projectId)}
        AND project.jurisdiction IS NULL
    )
      AND (
        SELECT COUNT(*) FROM sessions session
        WHERE session.project_id = ${sqlString(projectId)}
          AND session.ended_at <= ${sourceCutoffMs}
      ) = ${sourceSessionCount}
      AND (
        SELECT COUNT(*) FROM session_deletions deletion
        WHERE deletion.project_id = ${sqlString(projectId)}
      ) = ${activeDeletionCount}
    ON CONFLICT(project_id) DO UPDATE SET
      source_session_count = excluded.source_session_count,
      source_cutoff_ms = excluded.source_cutoff_ms,
      required_sequence = excluded.required_sequence,
      report_id = excluded.report_id,
      completed_at = excluded.completed_at;`;
}

export function sqlString(value) {
  if (typeof value !== "string") throw new Error("SQL text values must be strings.");
  return `'${value.replaceAll("'", "''")}'`;
}

function outboxRecord(payload) {
  return {
    exportId: payload.export_id,
    payload,
    projectId: payload.project_id,
    recordKind: payload.record_kind,
    sessionId: payload.session_id,
  };
}

function serializeOutboxPayload(record) {
  const payloadJson = JSON.stringify(record?.payload);
  if (typeof payloadJson !== "string") {
    throw new Error(`Analytics export ${String(record?.exportId)} has no JSON payload.`);
  }
  const payloadBytes = utf8Bytes(payloadJson);
  if (payloadBytes > ANALYTICS_OUTBOX_PAYLOAD_MAX_BYTES) {
    throw new Error(`Analytics export ${String(record?.exportId)} is larger than 32 KiB.`);
  }
  return payloadJson;
}

function sessionEventsSql(sessions) {
  const conditions = sessions.map(
    (session) =>
      `(project_id = ${sqlString(requireText(session?.project_id, "project_id"))} AND session_id = ${sqlString(requireText(session?.session_id, "session_id"))})`,
  );
  return `SELECT project_id, session_id, t, kind, detail
     FROM session_events
     WHERE ${conditions.join(" OR ")}
     ORDER BY project_id, session_id, t, kind`;
}

function utf8Bytes(value) {
  return utf8Encoder.encode(value).byteLength;
}

function isSimpleResourceName(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(value);
}

function requireId(value, label) {
  const text = requireText(value, label);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(text)) {
    throw new Error(`${label} must be 1 to 64 letters, numbers, dashes, or underscores.`);
  }
  return text;
}

function requireEventKind(value) {
  const eventKind = requireText(value, "event_kind");
  if (!allowedEventKinds.has(eventKind)) {
    throw new Error(`event_kind ${JSON.stringify(eventKind)} is not supported.`);
  }
  return eventKind;
}

function requireText(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  return value;
}

function requireBoundedText(value, label, maximumLength) {
  const text = requireText(value, label);
  if (text.length === 0 || text.length > maximumLength) {
    throw new Error(`${label} must be between 1 and ${maximumLength} characters.`);
  }
  return text;
}

function nullableText(value, label) {
  if (value === null || value === undefined) return null;
  return requireText(value, label);
}

function nullableBoundedText(value, label, maximumLength) {
  const text = nullableText(value, label);
  if (text === null || text.length <= maximumLength) return text;
  return text.slice(0, maximumLength);
}

function nullableSafeInteger(value, label) {
  if (value === null || value === undefined) return null;
  return asSafeInteger(value, label);
}

function nullableNonNegativeSafeInteger(value, label) {
  if (value === null || value === undefined) return null;
  return nonNegativeSafeInteger(value, label);
}

function nullableSafeIntegerInRange(value, label, minimum, maximum) {
  const number = nullableSafeInteger(value, label);
  if (number === null || (number >= minimum && number <= maximum)) return number;
  throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
}

function asSafeInteger(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} must be a safe whole number.`);
  return number;
}

function nonNegativeSafeInteger(value, label) {
  const number = asSafeInteger(value, label);
  if (number < 0) throw new Error(`${label} cannot be negative.`);
  return number;
}

function positiveSafeInteger(value, label) {
  const number = asSafeInteger(value, label);
  if (number <= 0) throw new Error(`${label} must be positive.`);
  return number;
}

function escapePattern(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
