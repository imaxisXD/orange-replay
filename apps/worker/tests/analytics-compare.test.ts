import { describe, expect, it } from "vite-plus/test";
import { sameStatsWithoutErrors, warehouseIncludesD1Errors } from "../src/api/project-routes.ts";
import { sameSessionPage } from "../src/api/session-routes.ts";
import { readStatsRows } from "../src/analytics/warehouse-read.ts";
import { canCompareD1Exactly } from "../src/analytics/compare.ts";

describe("analytics compare proof", () => {
  it("does not call sparse D1 error evidence an exact mismatch", () => {
    expect(canCompareD1Exactly({})).toBe(true);
    expect(canCompareD1Exactly({ error_detail: "Checkout failed" })).toBe(false);
  });

  it("allows tiny engine rounding differences but keeps counts exact", () => {
    const d1 = stats();
    const warehouse = structuredClone(d1);
    warehouse.duration.average.value += 0.000_000_1;
    warehouse.pagesPerSession.value = (warehouse.pagesPerSession.value ?? 0) + 0.000_000_1;

    expect(sameStatsWithoutErrors(d1, warehouse)).toBe(true);

    warehouse.sessions.value += 1;
    expect(sameStatsWithoutErrors(d1, warehouse)).toBe(false);
  });

  it("checks sparse error labels without depending on warehouse top-five order", () => {
    const d1 = stats();
    d1.errors = [
      {
        detail: "Checkout failed",
        filter: { error_detail: "Checkout failed" },
        count: { value: 2, filter: { error_detail: "Checkout failed" } },
        affectedSessions: { value: 1, filter: { error_detail: "Checkout failed" } },
      },
    ];

    expect(
      warehouseIncludesD1Errors(
        d1,
        new Map([["Checkout failed", { count: 4, affectedSessions: 2 }]]),
      ),
    ).toBe(true);
    expect(warehouseIncludesD1Errors(d1, new Map())).toBe(false);
  });

  it("compares the D1 session page without warehouse-only response fields", () => {
    const page = {
      sessions: [
        {
          session_id: "session_1",
          project_id: "project_1",
          started_at: 100,
        },
      ],
      nextBefore: null,
    };

    expect(
      sameSessionPage(
        page as never,
        {
          ...page,
          warehouseVersion: 12,
          metrics: { bytesScanned: 1, filesScanned: 1 },
        } as never,
      ),
    ).toBe(true);

    expect(
      sameSessionPage(
        page as never,
        {
          sessions: [{ ...page.sessions[0], session_id: "session_2" }],
          nextBefore: null,
        } as never,
      ),
    ).toBe(false);
  });
});

function stats() {
  return readStatsRows(
    [
      {
        project_id: "project_1",
        row_kind: "aggregate",
        group_name: null,
        label: null,
        session_count: 5,
        event_count: null,
        affected_sessions: null,
        average_duration_ms: 1_200,
        p50_duration_ms: 900,
        total_clicks: 20,
        included_sessions: 4,
        total_pages: 8,
        insight_sessions: 4,
        rage_sessions: 2,
        quick_back_sessions: 1,
        average_interaction_time_ms: 700,
        average_max_scroll_depth: 80,
      },
    ],
    {},
  );
}
