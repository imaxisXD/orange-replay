import type { IndexEvent, SegmentRef, SessionManifest } from "@orange-replay/shared/types";

export interface ReplayTab {
  id: string;
  label: string;
  firstEventAt: number;
  firstSnapshotAt?: number;
  path?: string;
}

/** Tab identity comes from saved batch checkpoints and timeline metadata. */
export function listReplayTabs(
  manifest: Pick<SessionManifest, "timeline" | "segments">,
  segments: readonly SegmentRef[] = manifest.segments,
): ReplayTab[] {
  const tabs = new Map<string, Omit<ReplayTab, "label">>();
  for (const segment of segments) {
    for (const checkpoint of segment.checkpoints ?? []) {
      const tab = tabs.get(checkpoint.tab) ?? {
        id: checkpoint.tab,
        firstEventAt: checkpoint.timestamp,
      };
      tab.firstEventAt = Math.min(tab.firstEventAt, checkpoint.timestamp);
      tab.firstSnapshotAt = Math.min(
        tab.firstSnapshotAt ?? checkpoint.timestamp,
        checkpoint.timestamp,
      );
      tabs.set(tab.id, tab);
    }
  }
  for (const event of manifest.timeline.toSorted((left, right) => left.t - right.t)) {
    if (event.tab === undefined) continue;
    const tab = tabs.get(event.tab) ?? { id: event.tab, firstEventAt: event.t };
    tab.firstEventAt = Math.min(tab.firstEventAt, event.t);
    tab.path ??= eventPath(event);
    tabs.set(tab.id, tab);
  }
  return [...tabs.values()]
    .toSorted(
      (left, right) => left.firstEventAt - right.firstEventAt || left.id.localeCompare(right.id),
    )
    .map((tab, index) => ({ ...tab, label: `Tab ${index + 1}` }));
}

export function timelineForReplayTab(events: readonly IndexEvent[], tab?: string): IndexEvent[] {
  // Untagged legacy events remain visible, but do not invent an origin tab.
  return events.filter(
    (event) => event.tab === undefined || tab === undefined || event.tab === tab,
  );
}

function eventPath(event: IndexEvent): string | undefined {
  const url =
    event.k === "nav"
      ? event.d
      : event.k === "vital" && event.d === "navigation"
        ? event.m?.["url"]
        : undefined;
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url, "https://replay.invalid");
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return parsed.pathname;
  } catch {
    return undefined;
  }
}
