export const hostedProjectBootstrapReportId = "new-project-bootstrap:hosted-account";

export function prepareNewProjectAnalyticsReceipt(
  database: D1Database,
  projectId: string,
  createdAt: number,
  reportId: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO analytics_backfill_completions
        (project_id, source_session_count, source_cutoff_ms, required_sequence, report_id, completed_at)
        SELECT ?, 0, ?, 0, ?, ?
        WHERE changes() = 1`,
    )
    .bind(projectId, createdAt, reportId, createdAt);
}
