import type { SessionListItem } from "../../lib/api/sessions";

export function sessionEvidenceLabel(
  session: Pick<SessionListItem, "clicks" | "has_checkpoint" | "page_count" | "segment_count">,
): string {
  if (session.segment_count === 0 || session.has_checkpoint === false) return "Metadata only";
  const pages = session.page_count;
  if (pages === null) return `${session.clicks} ${session.clicks === 1 ? "click" : "clicks"}`;
  return `${session.clicks} ${session.clicks === 1 ? "click" : "clicks"} · ${pages} ${pages === 1 ? "page" : "pages"}`;
}
