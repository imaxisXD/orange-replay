import type { SessionFilter } from "@orange-replay/shared";
import { formatDuration } from "./format";

export interface FilterChip {
  key: string;
  label: string;
}

const MAX_VALUE_CHARS = 40;

// The dashboard-level date window (from/to) and the doorway warehouse pin are
// not page-local lenses: the range selector owns them and neither ever renders
// as a chip or counts toward the filtered-empty-state decision.
const DATE_RANGE_KEYS = new Set(["from", "to", "warehouse_version"]);

function isPageLocalLens(key: string, value: unknown): boolean {
  return value !== undefined && !DATE_RANGE_KEYS.has(key);
}

/**
 * One chip per active SessionFilter key, so a doorway arrival from the
 * overview shows exactly what is filtering the list. from/to are the
 * dashboard-level date window, owned by the toolbar's range selector — never
 * a chip. Unknown keys fall back to key=value so newly added shared filter
 * keys still surface.
 */
export function filterChips(filter: SessionFilter): FilterChip[] {
  const chips: FilterChip[] = [];
  const record = filter as Record<string, unknown>;

  for (const [key, value] of Object.entries(record)) {
    if (!isPageLocalLens(key, value)) continue;
    chips.push({ key, label: chipLabel(key, value) });
  }

  return chips;
}

/**
 * Count of active page-local lenses, computed straight from the filter rather
 * than from the rendered chip list. The empty state uses this — not the
 * visible chip count — to decide whether a zero result is filtered or simply a
 * date range with no recordings.
 */
export function pageLocalLensCount(filter: SessionFilter): number {
  const record = filter as Record<string, unknown>;
  let count = 0;
  for (const [key, value] of Object.entries(record)) {
    if (isPageLocalLens(key, value)) count += 1;
  }
  return count;
}

export function removeFilterKey(filter: SessionFilter, key: string): SessionFilter {
  const next = { ...(filter as Record<string, unknown>) };
  delete next[key];
  return next as SessionFilter;
}

function chipLabel(key: string, value: unknown): string {
  const text = truncate(String(value));
  switch (key) {
    case "country":
      return `Country ${text}`;
    case "region":
      return `Region ${text}`;
    case "city":
      return `City ${text}`;
    case "device":
      return `Device ${text}`;
    case "browser":
      return `Browser ${text}`;
    case "os":
      return `OS ${text}`;
    case "entry_url":
      return `Entry = ${text}`;
    case "entry_url_prefix":
      return `Entry starts ${text}`;
    case "error_detail":
      return `Error: ${text}`;
    case "has_errors":
      return value === true ? "Has errors" : "No errors";
    case "has_rage":
      return value === true ? "Has rage" : "No rage";
    case "has_quick_back":
      return value === true ? "Has quick backs" : "No quick backs";
    case "has_insights":
      return "Has insights";
    case "min_duration_ms":
      return `≥ ${formatDuration(Number(value))}`;
    default:
      return `${key}=${text}`;
  }
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value;
}
