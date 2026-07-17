export type SessionCardStatus = "live" | "pending" | null;

export type SessionCardEvidence =
  | { kind: "starting" }
  | { kind: "provisional"; durationMs: number }
  | { kind: "metadata" }
  | { kind: "exact"; clicks: number; durationMs: number };

export function sessionCardStatus(session: {
  activity: "live" | "idle" | "finalizing" | "complete";
  details_state: "provisional" | "exact";
}): SessionCardStatus {
  if (session.activity === "live") return "live";
  if (session.details_state === "provisional") return "pending";
  return null;
}

/** Never exposes provisional placeholder zeroes as exact evidence. */
export function sessionCardEvidence(session: {
  clicks: number;
  details_state: "provisional" | "exact";
  duration_ms: number;
  has_checkpoint: boolean | null;
  segment_count: number;
}): SessionCardEvidence {
  if (session.details_state === "provisional") {
    if (session.duration_ms === 0) return { kind: "starting" };
    return { kind: "provisional", durationMs: session.duration_ms };
  }
  // A recording without a full-snapshot checkpoint has nothing to replay even
  // when segments exist; null means the row predates the playability fact.
  if (session.segment_count === 0 || session.has_checkpoint === false) {
    return { kind: "metadata" };
  }
  return { kind: "exact", clicks: session.clicks, durationMs: session.duration_ms };
}
