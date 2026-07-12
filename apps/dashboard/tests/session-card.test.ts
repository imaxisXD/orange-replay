import { describe, expect, it } from "vite-plus/test";
import { sessionEvidenceLabel } from "../src/routes/sessions/session-evidence";

describe("session card evidence", () => {
  it("labels metadata-only sessions before selection", () => {
    expect(sessionEvidenceLabel({ clicks: 0, page_count: 0, segment_count: 0 })).toBe(
      "Metadata only",
    );
  });

  it("summarizes clicks and covered pages", () => {
    expect(sessionEvidenceLabel({ clicks: 1, page_count: 1, segment_count: 2 })).toBe(
      "1 click · 1 page",
    );
    expect(sessionEvidenceLabel({ clicks: 12, page_count: 3, segment_count: 2 })).toBe(
      "12 clicks · 3 pages",
    );
  });

  it("keeps click evidence when page coverage is unavailable", () => {
    expect(sessionEvidenceLabel({ clicks: 2, page_count: null, segment_count: 1 })).toBe(
      "2 clicks",
    );
  });
});
