import type { IndexEvent } from "@orange-replay/shared/types";
import type { DeadClick } from "@orange-replay/player";

const displayableKinds = new Set<SidebarEventKind>([
  "click",
  "error",
  "rage",
  "nav",
  "scroll",
  "custom",
]);

export type SidebarEventKind =
  | Extract<IndexEvent["k"], "click" | "error" | "rage" | "nav" | "scroll" | "custom">
  | "dead-click";
export type TimelineDot = "blue" | "danger" | "amber" | "teal" | "hollow" | "dim" | "success";

export interface TimelineSidebarOptions {
  startedAt: number;
  durationMs: number;
  selectedTab?: string;
}

export interface TimelineSidebarRow {
  id: string;
  type: SidebarEventKind;
  dot: TimelineDot;
  label: string;
  detail?: string;
  offsetMs: number;
  offsetLabel: string;
  tab?: string;
}

export interface JourneyBreadcrumb {
  id: string;
  path: string;
  offsetMs: number;
}

export type PlayerKeyAction = { type: "toggle-play" } | { type: "seek"; deltaMs: -5000 | 5000 };

export interface PlayerKeyEvent {
  key: string;
  target: EventTarget | null;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export function timelineXToTime(xPx: number, durationMs: number, widthPx: number): number {
  if (durationMs <= 0 || widthPx <= 0 || !Number.isFinite(xPx)) {
    return 0;
  }

  return Math.round((clamp(xPx, 0, widthPx) / widthPx) * durationMs);
}

export function timelineProgressPercent(timeMs: number, durationMs: number): number {
  if (durationMs <= 0 || !Number.isFinite(timeMs)) {
    return 0;
  }

  return (clamp(timeMs, 0, durationMs) / durationMs) * 100;
}

export function mapTimelineSidebarRows(
  events: readonly IndexEvent[],
  options: TimelineSidebarOptions,
  deadClicks: readonly DeadClick[] = [],
): TimelineSidebarRow[] {
  const durationMs = Math.max(0, Math.floor(options.durationMs));
  const deadClickByTime = new Map(deadClicks.map((click) => [click.t, click]));
  const displayable = events
    .filter((event): event is IndexEvent & { k: Exclude<SidebarEventKind, "dead-click"> } =>
      displayableKinds.has(event.k as SidebarEventKind),
    )
    .toSorted((left, right) => left.t - right.t);
  const rows: TimelineSidebarRow[] = [];

  for (let index = 0; index < displayable.length; index += 1) {
    const event = displayable[index];
    if (event === undefined) {
      continue;
    }

    const offsetMs = clamp(event.t - options.startedAt, 0, durationMs);

    if (event.k === "scroll") {
      // An uninterrupted run of scroll events is one reading gesture, not a
      // list of moments — collapse it into a single row so scrolling never
      // drowns out clicks and errors. The SDK throttles scrolls to one per
      // 2s, so the deepest point of the run is the fact worth surfacing.
      let deepestDepth = scrollDepth(event);
      while (displayable[index + 1]?.k === "scroll" && displayable[index + 1]?.tab === event.tab) {
        index += 1;
        const nextDepth = scrollDepth(displayable[index]);
        if (nextDepth !== undefined && (deepestDepth === undefined || nextDepth > deepestDepth)) {
          deepestDepth = nextDepth;
        }
      }

      rows.push({
        id: `scroll-${event.t}-${rows.length}`,
        type: "scroll",
        dot: "dim",
        label: "Scrolled",
        ...(deepestDepth === undefined ? {} : { detail: `${deepestDepth}% depth` }),
        offsetMs,
        offsetLabel: formatOffsetTime(offsetMs),
        ...(event.tab === undefined ? {} : { tab: event.tab }),
      });
      continue;
    }

    const deadClick =
      event.k === "click" &&
      (event.tab === undefined ||
        options.selectedTab === undefined ||
        event.tab === options.selectedTab)
        ? deadClickByTime.get(event.t)
        : undefined;
    if (deadClick !== undefined) {
      rows.push({
        id: `dead-click-${event.t}-${rows.length}`,
        type: "dead-click",
        dot: "hollow",
        label: "Dead click",
        detail: shortSelector(deadClick.detail),
        offsetMs,
        offsetLabel: formatOffsetTime(offsetMs),
        ...(event.tab === undefined ? {} : { tab: event.tab }),
      });
      continue;
    }

    const content = eventRowContent(event);
    rows.push({
      id: `${event.k}-${event.t}-${rows.length}`,
      type: event.k,
      dot: dotForEvent(event.k),
      label: content.label,
      ...(content.detail !== undefined ? { detail: content.detail } : {}),
      offsetMs,
      offsetLabel: formatOffsetTime(offsetMs),
      ...(event.tab === undefined ? {} : { tab: event.tab }),
    });
  }

  return rows;
}

function scrollDepth(event: IndexEvent | undefined): number | undefined {
  const depth = event?.m?.["depth"];
  if (typeof depth !== "number" || !Number.isFinite(depth)) {
    return undefined;
  }

  return Math.round(clamp(depth, 0, 100));
}

export function buildJourneyBreadcrumbs(
  entryUrl: string | undefined,
  events: readonly IndexEvent[],
  options: TimelineSidebarOptions,
): JourneyBreadcrumb[] {
  const durationMs = Math.max(0, Math.floor(options.durationMs));
  const breadcrumbs: JourneyBreadcrumb[] = [];

  if (entryUrl !== undefined && entryUrl.trim().length > 0) {
    breadcrumbs.push({ id: "entry", path: shortPath(entryUrl), offsetMs: 0 });
  }

  for (const [index, event] of events
    .filter((item) => item.k === "nav" || isPageLoadEvent(item))
    .toSorted((left, right) => left.t - right.t)
    .entries()) {
    const target =
      event.k === "nav"
        ? (event.d ?? firstMetaText(event, ["url", "href", "to", "path"]))
        : firstMetaText(event, ["url"]);
    if (target === undefined) {
      continue;
    }

    const path = shortPath(target);
    const offsetMs = clamp(event.t - options.startedAt, 0, durationMs);
    if (isPageLoadEvent(event) && offsetMs === 0 && breadcrumbs[0]?.path === path) {
      continue;
    }

    breadcrumbs.push({
      id: `${event.k === "nav" ? "nav" : "load"}-${event.t}-${index}`,
      path,
      offsetMs,
    });
  }

  return breadcrumbs;
}

function isPageLoadEvent(event: IndexEvent): boolean {
  return (
    event.k === "vital" && event.d === "navigation" && firstMetaText(event, ["url"]) !== undefined
  );
}

export function getPlayerKeyAction(event: PlayerKeyEvent): PlayerKeyAction | null {
  if (event.altKey === true || event.ctrlKey === true || event.metaKey === true) {
    return null;
  }

  if (shouldIgnorePlayerKeyTarget(event.target)) {
    return null;
  }

  if (event.key === " " || event.key === "Spacebar") {
    return { type: "toggle-play" };
  }

  if (event.key === "ArrowLeft") {
    return { type: "seek", deltaMs: -5000 };
  }

  if (event.key === "ArrowRight") {
    return { type: "seek", deltaMs: 5000 };
  }

  return null;
}

export function shouldIgnorePlayerKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable || target.closest("[contenteditable='true']") !== null) {
    return true;
  }

  if (["input", "textarea", "select"].includes(target.tagName.toLowerCase())) {
    return true;
  }

  return target.closest("button, a, [role='slider']") !== null;
}

export function formatOffsetTime(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1_000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);

  if (minutes < 60) {
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}:${remainingMinutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
}

function eventRowContent(event: IndexEvent & { k: SidebarEventKind }): {
  label: string;
  detail?: string;
} {
  if (event.k === "click") {
    // The human phrase leads; the CSS selector is supporting detail — a
    // sidebar row should read like a sentence, not like devtools.
    const selector = firstMetaText(event, ["selector", "target", "path"]) ?? event.d;
    const text = firstMetaText(event, ["text", "label"]);
    return {
      label: text === undefined ? "Clicked" : `Clicked “${truncateText(text, 40)}”`,
      ...(selector !== undefined ? { detail: shortSelector(selector) } : {}),
    };
  }

  if (event.k === "error") {
    const label = event.d ?? firstMetaText(event, ["message", "name"]) ?? "Error";
    const detail = firstMetaText(event, ["source", "file", "type"]);
    return {
      label: truncateText(label, 56),
      ...(detail !== undefined ? { detail: truncateText(detail, 56) } : {}),
    };
  }

  if (event.k === "rage") {
    const selector = firstMetaText(event, ["selector", "target", "path"]) ?? event.d;
    return {
      label: "Rage click",
      ...(selector !== undefined ? { detail: shortSelector(selector) } : {}),
    };
  }

  if (event.k === "custom") {
    // The developer-chosen event name is the headline; its metadata is
    // supporting detail, same shape as a click's selector line.
    const name = event.d?.trim();
    const detail = customMetaSummary(event);
    return {
      label: name === undefined || name.length === 0 ? "Custom event" : truncateText(name, 56),
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  const target = event.d ?? firstMetaText(event, ["url", "href", "to", "path"]) ?? "/";
  const detail = firstMetaText(event, ["title", "from", "referrer"]);
  return {
    label: `→ ${shortPath(target)}`,
    ...(detail !== undefined ? { detail: truncateText(detail, 56) } : {}),
  };
}

function dotForEvent(kind: SidebarEventKind): TimelineDot {
  if (kind === "click") return "blue";
  if (kind === "error") return "danger";
  if (kind === "rage") return "amber";
  if (kind === "custom") return "success";
  return "teal";
}

function customMetaSummary(event: IndexEvent): string | undefined {
  const entries = Object.entries(event.m ?? {})
    .filter(
      ([key, value]) =>
        key.trim().length > 0 &&
        (typeof value === "number" || (typeof value === "string" && value.trim().length > 0)),
    )
    .slice(0, 2)
    .map(([key, value]) => `${key.trim()}: ${String(value).trim()}`);

  if (entries.length === 0) {
    return undefined;
  }

  return truncateText(entries.join(" · "), 42);
}

function firstMetaText(event: IndexEvent, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = event.m?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

function shortSelector(value: string): string {
  const cleanValue = value.trim();
  let lastPart: string | undefined;
  for (const part of cleanValue.split(">")) {
    const cleanPart = part.trim();
    if (cleanPart.length > 0) {
      lastPart = cleanPart;
    }
  }

  return truncateText(lastPart ?? cleanValue, 42);
}

function shortPath(value: string): string {
  const cleanValue = value.trim();

  try {
    const url = new URL(cleanValue);
    return `${url.pathname}${url.search}`;
  } catch {
    if (cleanValue.length === 0) {
      return "/";
    }

    return cleanValue.startsWith("/") ? cleanValue : `/${cleanValue}`;
  }
}

function truncateText(value: string, maxLength: number): string {
  const cleanValue = value.trim();
  if (cleanValue.length <= maxLength) {
    return cleanValue;
  }

  return `${cleanValue.slice(0, Math.max(0, maxLength - 3))}...`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
