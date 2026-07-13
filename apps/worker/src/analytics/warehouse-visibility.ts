import { runR2SqlProjectQuery, type R2SqlSettings } from "./r2-sql-client.ts";
import { sqlText, sqlWholeNumber } from "./sql.ts";
import { analyticsQualifiedTableNames } from "./warehouse-query.ts";

const MAX_VISIBILITY_IDS = 90;

export interface WarehouseVisibilityInput {
  projectId: string;
  exportIds: readonly string[];
  sessionIds: readonly string[];
  throughSequence: number;
}

/**
 * Builds the proof query used before advancing a project's warehouse version.
 * A complete session is visible only when its session row, every sidecar event,
 * and the final coverage marker are all visible in their separate sink tables.
 */
export function buildWarehouseVisibilityQuery(input: WarehouseVisibilityInput): string {
  if (input.exportIds.length === 0 || input.exportIds.length > MAX_VISIBILITY_IDS) {
    throw new Error("Analytics visibility needs between 1 and 90 export ids");
  }
  if (input.sessionIds.length === 0 || input.sessionIds.length > MAX_VISIBILITY_IDS) {
    throw new Error("Analytics visibility needs between 1 and 90 session ids");
  }
  const project = sqlText(input.projectId);
  const version = sqlWholeNumber(input.throughSequence, "Warehouse version");
  const ids = input.exportIds.map(sqlText).join(", ");
  const sessionIds = input.sessionIds.map(sqlText).join(", ");

  // The Pipeline sinks already reject rows that miss required fields. Keeping
  // the same long null-check list here makes live R2 SQL reject this proof as
  // too deeply nested before it can check visibility.
  return `WITH scoped_sessions AS (
  SELECT s.*,
    ROW_NUMBER() OVER (
      PARTITION BY s.project_id, s.export_id
      ORDER BY s.export_sequence DESC, s.recorded_at DESC
    ) AS retry_rank
  FROM ${analyticsQualifiedTableNames.sessions} s
  WHERE s.project_id = ${project}
    AND s.export_sequence <= ${version}
    AND s.export_id IN (${ids})
),
one_session AS (
  SELECT * FROM scoped_sessions WHERE retry_rank = 1
),
scoped_events AS (
  SELECT e.*,
    ROW_NUMBER() OVER (
      PARTITION BY e.project_id, e.export_id
      ORDER BY e.export_sequence DESC, e.recorded_at DESC
    ) AS retry_rank
  FROM ${analyticsQualifiedTableNames.events} e
  WHERE e.project_id = ${project}
    AND e.export_sequence <= ${version}
    AND e.session_id IN (${sessionIds})
),
one_event AS (
  SELECT * FROM scoped_events WHERE retry_rank = 1
),
scoped_deletions AS (
  SELECT d.*,
    ROW_NUMBER() OVER (
      PARTITION BY d.project_id, d.export_id
      ORDER BY d.export_sequence DESC, d.recorded_at DESC
    ) AS retry_rank
  FROM ${analyticsQualifiedTableNames.deletions} d
  WHERE d.project_id = ${project}
    AND d.export_sequence <= ${version}
    AND d.export_id IN (${ids})
),
visible_sessions AS (
  SELECT s.project_id, s.export_id
  FROM one_session s
  WHERE s.event_coverage <> 'complete'
    OR (
      EXISTS (
        SELECT 1 FROM one_event marker
        WHERE marker.project_id = s.project_id
          AND marker.session_id = s.session_id
          AND marker.export_id = s.export_id
          AND marker.event_kind = 'coverage_complete'
          AND marker.event_index = s.event_count
      )
      AND (
        SELECT COUNT(*) FROM one_event e
        WHERE e.project_id = s.project_id
          AND e.session_id = s.session_id
          AND e.export_sequence = s.export_sequence
          AND e.event_kind <> 'coverage_complete'
      ) = s.event_count
    )
),
visible_sparse_events AS (
  SELECT e.project_id, e.export_id
  FROM one_event e
  WHERE e.export_id IN (${ids}) AND e.event_kind <> 'coverage_complete'
),
visible_deletions AS (
  SELECT d.project_id, d.export_id
  FROM scoped_deletions d
  WHERE d.retry_rank = 1
)
SELECT project_id, export_id FROM visible_sessions
UNION ALL
SELECT project_id, export_id FROM visible_sparse_events
UNION ALL
SELECT project_id, export_id FROM visible_deletions`;
}

export function createR2SqlVisibilityAdapter(settings: R2SqlSettings): {
  findVisibleExportIds(input: WarehouseVisibilityInput): Promise<ReadonlySet<string>>;
} {
  return {
    async findVisibleExportIds(input) {
      const query = buildWarehouseVisibilityQuery(input);
      const result = await runR2SqlProjectQuery<{ project_id: string; export_id: string }>(
        settings,
        input.projectId,
        query,
      );
      const visible = new Set<string>();
      for (const row of result.rows) {
        if (typeof row.export_id !== "string" || !input.exportIds.includes(row.export_id)) {
          throw new Error("Analytics visibility returned an unknown export id");
        }
        visible.add(row.export_id);
      }
      return visible;
    },
  };
}
