export function buildNewProjectAnalyticsReceiptSql({ projectId, createdAt, reportId }) {
  const cleanProjectId = readRequiredText(projectId, "projectId");
  const cleanReportId = readRequiredText(reportId, "reportId");
  if (cleanReportId.length > 200) {
    throw new Error("reportId must be 200 characters or less");
  }
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw new Error("createdAt must be a positive whole number");
  }

  return `INSERT INTO analytics_backfill_completions (project_id, source_session_count, source_cutoff_ms, required_sequence, report_id, completed_at) SELECT ${sqlString(
    cleanProjectId,
  )}, 0, ${createdAt}, 0, ${sqlString(cleanReportId)}, ${createdAt} WHERE changes() = 1`;
}

function readRequiredText(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
