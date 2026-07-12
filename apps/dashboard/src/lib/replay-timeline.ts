import type { IndexEvent } from "@orange-replay/shared/types";
import type { DeadClick } from "@orange-replay/player";

const displayableKinds = new Set<SidebarEventKind>(["click", "error", "rage", "nav"]);

export type SidebarEventKind =
  | Extract<IndexEvent["k"], "click" | "error" | "rage" | "nav">
  | "dead-click";
export type TimelineDot = "blue" | "danger" | "amber" | "teal" | "hollow";

export interface TimelineSidebarOptions {
  startedAt: number;
  durationMs: number;
}

export interface TimelineSidebarRow {
  id: string;
  type: SidebarEventKind;
  dot: TimelineDot;
  label: string;
  detail?: string;
  offsetMs: number;
  offsetLabel: string;
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

  return events
    .filter((event): event is IndexEvent & { k: "click" | "error" | "rage" | "nav" } =>
      displayableKinds.has(event.k as "click" | "error" | "rage" | "nav"),
    )
    .toSorted((left, right) => left.t - right.t)
    .map((event, index) => {
      const offsetMs = clamp(event.t - options.startedAt, 0, durationMs);
      const deadClick = event.k === "click" ? deadClickByTime.get(event.t) : undefined;
      if (deadClick !== undefined) {
        return {
          id: `dead-click-${event.t}-${index}`,
          type: "dead-click" as const,
          dot: "hollow" as const,
          label: "Dead click",
          detail: shortSelector(deadClick.detail),
          offsetMs,
          offsetLabel: formatOffsetTime(offsetMs),
        };
      }
      const content = eventRowContent(event);

      return {
        id: `${event.k}-${event.t}-${index}`,
        type: event.k,
        dot: dotForEvent(event.k),
        label: content.label,
        ...(content.detail !== undefined ? { detail: content.detail } : {}),
        offsetMs,
        offsetLabel: formatOffsetTime(offsetMs),
      };
    });
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
  return "teal";
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
