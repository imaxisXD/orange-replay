import { describe, expect, it } from "vite-plus/test";
import { buildWarehouseVisibilityQuery } from "../src/analytics/warehouse-visibility.ts";

describe("analytics warehouse visibility", () => {
  it("requires the session, exact event count, and coverage marker", () => {
    const query = buildWarehouseVisibilityQuery({
      projectId: "project-safe",
      exportIds: ["session:project-safe:one", "event:project-safe:one:0:10:error"],
      sessionIds: ["one"],
      throughSequence: 42,
    });

    expect(query).toContain('FROM "default"."analytics_sessions"');
    expect(query).toContain('FROM "default"."analytics_events"');
    expect(query).toContain('FROM "default"."analytics_deletions"');
    expect(query).toContain("marker.event_index = s.event_count");
    expect(query).toContain(") = s.event_count");
    expect(query).toContain("s.export_sequence <= 42");
    expect(query).toContain("e.session_id IN ('one')");
  });

  it("keeps quote and SQL comment text inside literals", () => {
    const query = buildWarehouseVisibilityQuery({
      projectId: "project' OR 1=1 --",
      exportIds: ["session:x' UNION SELECT secret --"],
      sessionIds: ["session' --"],
      throughSequence: 1,
    });

    expect(query).toContain("project'' OR 1=1 --");
    expect(query).toContain("session:x'' UNION SELECT secret --");
    expect(query).not.toContain("project' OR 1=1 --'");
  });

  it("rejects an unsafe batch size", () => {
    expect(() =>
      buildWarehouseVisibilityQuery({
        projectId: "project",
        exportIds: [],
        sessionIds: ["session"],
        throughSequence: 1,
      }),
    ).toThrow("between 1 and 90");
  });
});
