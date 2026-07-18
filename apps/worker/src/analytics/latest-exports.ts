/**
 * The one SQL statement of the export retry-dedupe invariant.
 *
 * Accepted producer retries create physical duplicates in every warehouse
 * table, so exactly one logical row exists per (project_id, export_id): the
 * copy with the highest export_sequence, breaking ties by recorded_at. The
 * read queries, the watermark visibility proof, and both deletion backends
 * must all choose rows through this CTE — if any of them ranked rows its own
 * way, the write-side and read-side answers could silently disagree.
 */
export interface LatestAcceptedExportsScope {
  cteName: string;
  /** Qualified table name, e.g. `"default"."analytics_sessions"`. */
  table: string;
  alias: string;
  /** Pre-escaped select list; the rank column is appended after it. */
  select: string;
  rankAlias: string;
  /** Optional pre-escaped JOIN text placed between FROM and WHERE. */
  join?: string;
  /** Pre-escaped WHERE clauses; scoping (project, version pin, ids) is the caller's decision. */
  where: readonly string[];
}

export function latestAcceptedExportsCte(scope: LatestAcceptedExportsScope): string {
  if (scope.where.length === 0) {
    throw new Error("A latest-exports scope needs at least one WHERE clause");
  }
  const alias = scope.alias;
  const joinSql = scope.join === undefined ? `` : `\n  ${scope.join}`;
  return `${scope.cteName} AS (
  SELECT ${scope.select},
    ROW_NUMBER() OVER (
      PARTITION BY ${alias}.project_id, ${alias}.export_id
      ORDER BY ${alias}.export_sequence DESC, ${alias}.recorded_at DESC
    ) AS ${scope.rankAlias}
  FROM ${scope.table} ${alias}${joinSql}
  WHERE ${scope.where.join("\n    AND ")}
)`;
}
