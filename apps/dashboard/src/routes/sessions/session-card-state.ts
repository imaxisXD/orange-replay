export type SessionCardStatus = "live" | "pending" | null;

export type SessionCardEvidence =
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
  segment_count: number;
}): SessionCardEvidence {
  if (session.details_state === "provisional") {
    return { kind: "provisional", durationMs: session.duration_ms };
  }
  if (session.segment_count === 0) return { kind: "metadata" };
  return { kind: "exact", clicks: session.clicks, durationMs: session.duration_ms };
}
