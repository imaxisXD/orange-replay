import { describe, expect, it } from "vite-plus/test";
import { buildAnalyticsDeletionV2VisibilityQuery } from "../src/analytics/deletion-v2.ts";
import { latestAcceptedExportsCte } from "../src/analytics/latest-exports.ts";
import {
  buildWarehouseSessionsQuery,
  buildWarehouseStatsQuery,
} from "../src/analytics/warehouse-query.ts";
import { buildWarehouseVisibilityQuery } from "../src/analytics/warehouse-visibility.ts";

/**
 * The exact window the shared builder emits. Every warehouse query must pick
 * rows through this spec so the write-side proof and the read-side queries
 * cannot rank retries differently.
 */
function dedupeWindow(alias: string): string {
  return `ROW_NUMBER() OVER (
      PARTITION BY ${alias}.project_id, ${alias}.export_id
      ORDER BY ${alias}.export_sequence DESC, ${alias}.recorded_at DESC
    )`;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("latest accepted exports CTE", () => {
  it("emits the dedupe window with the caller's scope and nothing else", () => {
    const cte = latestAcceptedExportsCte({
      cteName: "scoped_rows",
      table: '"default"."analytics_sessions"',
      alias: "s",
      select: "s.*",
      rankAlias: "retry_rank",
      where: ["s.project_id = 'p'", "s.export_sequence <= 7"],
    });

    expect(cte).toContain("scoped_rows AS (");
    expect(cte).toContain(dedupeWindow("s"));
    expect(cte).toContain('FROM "default"."analytics_sessions" s');
    expect(cte).toContain("WHERE s.project_id = 'p'\n    AND s.export_sequence <= 7");
    expect(cte).not.toContain("JOIN");
  });

  it("refuses an unscoped table", () => {
    expect(() =>
      latestAcceptedExportsCte({
        cteName: "scoped_rows",
        table: '"default"."analytics_sessions"',
        alias: "s",
        select: "s.*",
        rankAlias: "retry_rank",
        where: [],
      }),
    ).toThrow("at least one WHERE clause");
  });

  it("is the only retry-ranking used by the visibility proof and every read query", () => {
    const proof = buildWarehouseVisibilityQuery({
      projectId: "project_1",
      exportIds: ["session:project_1:one"],
      sessionIds: ["one"],
      throughSequence: 42,
    });
    const sessions = buildWarehouseSessionsQuery("project_1", 42, {
      from: 100,
      to: 200,
      limit: 25,
      sort: "newest",
      error_detail: "Checkout failed",
    }).sql;
    const statsV2 = buildWarehouseStatsQuery("project_1", 42, { from: 100, to: 200 }, "v2").sql;
    const deletionV2 = buildAnalyticsDeletionV2VisibilityQuery({
      projectId: "project_1",
      records: [
        {
          schema_version: 2,
          record_kind: "deletion",
          export_id: "deletion-v2:project_1:one",
          export_sequence: 7,
          project_id: "project_1",
          session_id: "one",
          recorded_at: 1,
          deleted_at: 1,
          delete_reason: "retention",
          session_started_at: null,
        },
      ],
    });

    // The proof dedupes sessions, events, and deletions the same way the
    // read queries do: reconcile-visible rows stay read-selectable.
    for (const query of [proof, sessions, statsV2]) {
      expect(query).toContain(dedupeWindow("s"));
      expect(query).toContain(dedupeWindow("e"));
      expect(query).toContain(dedupeWindow("d"));
    }
    expect(deletionV2).toContain(dedupeWindow("d"));

    // No query ranks export retries with a window the shared builder did not
    // emit. The one extra window is the read path's per-session choice
    // (PARTITION BY session_id), which is a different invariant.
    for (const query of [proof, sessions, statsV2, deletionV2]) {
      const windows = count(query, "ROW_NUMBER() OVER (");
      const shared =
        count(query, dedupeWindow("s")) +
        count(query, dedupeWindow("e")) +
        count(query, dedupeWindow("d"));
      const sessionChoice = count(query, "PARTITION BY s.project_id, s.session_id");
      const presentation =
        count(query, "PARTITION BY group_name") + count(query, "ORDER BY affected_sessions DESC");
      expect(windows).toBe(shared + sessionChoice + presentation);
    }
  });
});
