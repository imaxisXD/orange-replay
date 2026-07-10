import type { SessionManifest } from "@orange-replay/shared/types";
import { formatDuration } from "../../../lib/format";
import { timelineProgressPercent, type JourneyBreadcrumb } from "../../../lib/replay-timeline";

export interface ErrorMarker {
  id: string;
  leftPercent: number;
  offsetLabel: string;
}

export interface RageMarker {
  id: string;
  leftPercent: number;
  offsetLabel: string;
}

export interface DeadClickMarker {
  id: string;
  leftPercent: number;
}

export type JourneyDisplayItem = JourneyBreadcrumb | { id: "collapsed"; collapsedCount: number };

export function buildErrorMarkers(manifest: SessionManifest): ErrorMarker[] {
  const markers: ErrorMarker[] = [];
  for (const event of manifest.timeline) {
    if (event.k !== "error") continue;

    markers.push({
      id: `${event.t}-${event.d ?? "error"}`,
      leftPercent: timelineProgressPercent(event.t - manifest.startedAt, manifest.durationMs),
      offsetLabel: formatDuration(Math.max(0, event.t - manifest.startedAt)),
    });
  }
  return markers;
}

export function buildRageMarkers(manifest: SessionManifest): RageMarker[] {
  const markers: RageMarker[] = [];
  for (const event of manifest.timeline) {
    if (event.k !== "rage") continue;

    markers.push({
      id: `${event.t}-rage-${markers.length}`,
      leftPercent: timelineProgressPercent(event.t - manifest.startedAt, manifest.durationMs),
      offsetLabel: formatDuration(Math.max(0, event.t - manifest.startedAt)),
    });
  }
  return markers;
}

export function buildDeadClickMarkers(
  manifest: SessionManifest,
  deadClicks: readonly { t: number }[],
): DeadClickMarker[] {
  return deadClicks.map((click, index) => ({
    id: `${click.t}-${index}`,
    leftPercent: timelineProgressPercent(click.t - manifest.startedAt, manifest.durationMs),
  }));
}

export function firstErrorOffset(manifest: SessionManifest): number | null {
  const firstError = manifest.timeline
    .filter((event) => event.k === "error")
    .toSorted((left, right) => left.t - right.t)[0];
  if (firstError === undefined) {
    return null;
  }

  return Math.max(0, firstError.t - manifest.startedAt - 2_000);
}

export function journeyDisplayItems(
  breadcrumbs: JourneyBreadcrumb[],
  expanded: boolean,
): JourneyDisplayItem[] {
  if (expanded || breadcrumbs.length <= 6) {
    return breadcrumbs;
  }

  const hiddenCount = breadcrumbs.length - 5;
  return [
    ...breadcrumbs.slice(0, 2),
    { id: "collapsed", collapsedCount: hiddenCount },
    ...breadcrumbs.slice(-3),
  ];
}
