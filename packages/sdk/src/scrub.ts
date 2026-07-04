const DEFAULT_DETAIL_LIMIT = 200;
const CLASS_LIMIT = 3;
const ANCESTOR_LIMIT = 3;
export const DEFAULT_BLOCK_SELECTOR = "[data-orange-block]";
export const BLOCKED_CLICK_DETAIL = "[blocked]";

export interface ViewportSize {
  width: number;
  height: number;
}

export interface NormalizedCoords {
  x: number;
  y: number;
}

export function scrubUrl(url: string, allowParams: readonly string[] = []): string {
  try {
    const base = currentBaseUrl();
    const parsed = new URL(url, base);
    const allowed = new Set(allowParams);
    const kept = new URLSearchParams();

    for (const [name, value] of parsed.searchParams) {
      if (allowed.has(name)) {
        kept.append(name, value);
      }
    }

    const query = kept.toString();
    return `${parsed.pathname}${query.length > 0 ? `?${query}` : ""}`;
  } catch {
    const withoutFragment = url.split("#", 1)[0] ?? "";
    const [path = "", query = ""] = withoutFragment.split("?", 2);

    if (query.length === 0 || allowParams.length === 0) {
      return path;
    }

    const allowed = new Set(allowParams);
    const kept = new URLSearchParams();
    const params = new URLSearchParams(query);

    for (const [name, value] of params) {
      if (allowed.has(name)) {
        kept.append(name, value);
      }
    }

    const keptQuery = kept.toString();
    return `${path}${keptQuery.length > 0 ? `?${keptQuery}` : ""}`;
  }
}

export function truncateDetail(value: string, limit = DEFAULT_DETAIL_LIMIT): string {
  if (value.length <= limit) {
    return value;
  }

  return value.slice(0, limit);
}

export function buildClickDetail(element: Element | null): string {
  if (element === null) {
    return "unknown";
  }

  const parts: string[] = [];
  let current: Element | null = element;

  while (current !== null && parts.length < ANCESTOR_LIMIT) {
    parts.unshift(selectorPart(current));
    current = current.parentElement;
  }

  return truncateDetail(parts.join(" > "));
}

export function mergeBlockSelector(extra: string | undefined): string {
  return extra === undefined ? DEFAULT_BLOCK_SELECTOR : `${DEFAULT_BLOCK_SELECTOR}, ${extra}`;
}

export function isBlockedElement(element: Element | null, selector: string): boolean {
  if (element === null) {
    return false;
  }

  try {
    return element.closest(selector) !== null;
  } catch {
    return element.closest(DEFAULT_BLOCK_SELECTOR) !== null;
  }
}

export function normalizedCoords(
  event: Pick<MouseEvent, "clientX" | "clientY">,
  viewport: ViewportSize,
): NormalizedCoords {
  return {
    x: roundRatio(viewport.width > 0 ? event.clientX / viewport.width : 0),
    y: roundRatio(viewport.height > 0 ? event.clientY / viewport.height : 0),
  };
}

function selectorPart(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id.length > 0 ? `#${cleanCssName(element.id)}` : "";
  const classes = Array.from(element.classList)
    .slice(0, CLASS_LIMIT)
    .map((className) => `.${cleanCssName(className)}`)
    .join("");

  return `${tag}${id}${classes}`;
}

function cleanCssName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function roundRatio(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 10_000) / 10_000;
}

function currentBaseUrl(): string {
  if (typeof window !== "undefined" && window.location.href.length > 0) {
    return window.location.href;
  }

  return "https://example.invalid/";
}
