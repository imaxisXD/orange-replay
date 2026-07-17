import { describe, expect, it } from "vite-plus/test";
import { sessionCardEvidence, sessionCardStatus } from "../src/routes/sessions/session-card-state";
import { sessionEvidenceLabel } from "../src/routes/sessions/session-evidence";

describe("session card evidence", () => {
  it("labels metadata-only sessions before selection", () => {
    expect(
      sessionEvidenceLabel({ clicks: 0, has_checkpoint: null, page_count: 0, segment_count: 0 }),
    ).toBe("Metadata only");
  });

  it("labels checkpoint-less recordings as metadata even with stored segments", () => {
    expect(
      sessionEvidenceLabel({ clicks: 0, has_checkpoint: false, page_count: 1, segment_count: 1 }),
    ).toBe("Metadata only");
  });

  it("summarizes clicks and covered pages", () => {
    expect(
      sessionEvidenceLabel({ clicks: 1, has_checkpoint: true, page_count: 1, segment_count: 2 }),
    ).toBe("1 click · 1 page");
    expect(
      sessionEvidenceLabel({ clicks: 12, has_checkpoint: true, page_count: 3, segment_count: 2 }),
    ).toBe("12 clicks · 3 pages");
  });

  it("keeps click evidence when page coverage is unavailable", () => {
    expect(
      sessionEvidenceLabel({ clicks: 2, has_checkpoint: null, page_count: null, segment_count: 1 }),
    ).toBe("2 clicks");
  });
});

describe("session card continuity", () => {
  it("labels live and pending rows from their real state", () => {
    expect(sessionCardStatus({ activity: "live", details_state: "provisional" })).toBe("live");
    expect(sessionCardStatus({ activity: "idle", details_state: "provisional" })).toBe("pending");
    expect(sessionCardStatus({ activity: "complete", details_state: "exact" })).toBeNull();
  });

  it("does not show provisional zero placeholders as exact evidence", () => {
    const evidence = sessionCardEvidence({
      clicks: 0,
      details_state: "provisional",
      duration_ms: 5_000,
      has_checkpoint: null,
      segment_count: 0,
    });

    expect(evidence).toEqual({ kind: "provisional", durationMs: 5_000 });
    expect(evidence).not.toHaveProperty("clicks");
    expect(evidence.kind).not.toBe("metadata");
  });

  it("shows a just-started state instead of a zero duration", () => {
    expect(
      sessionCardEvidence({
        clicks: 0,
        details_state: "provisional",
        duration_ms: 0,
        has_checkpoint: null,
        segment_count: 0,
      }),
    ).toEqual({ kind: "starting" });
  });

  it("treats a confirmed checkpoint-less recording as metadata only", () => {
    expect(
      sessionCardEvidence({
        clicks: 0,
        details_state: "exact",
        duration_ms: 0,
        has_checkpoint: false,
        segment_count: 1,
      }),
    ).toEqual({ kind: "metadata" });
  });

  it("keeps unknown playability on the previous segment-count behavior", () => {
    expect(
      sessionCardEvidence({
        clicks: 3,
        details_state: "exact",
        duration_ms: 4_000,
        has_checkpoint: null,
        segment_count: 2,
      }),
    ).toEqual({ kind: "exact", clicks: 3, durationMs: 4_000 });
  });
});
