import type { SessionFilter } from "@orange-replay/shared";
import { formatDuration } from "./format";
import { dateRangeShorthand } from "./session-count";

export interface FilterChip {
  key: string;
  label: string;
}

const MAX_VALUE_CHARS = 40;

/**
 * One chip per active SessionFilter key, so a doorway arrival from the
 * overview shows exactly what is filtering the list. from/to collapse into a
 * single range chip (removing it clears both). Unknown keys fall back to
 * key=value so newly added shared filter keys still surface.
 */
export function filterChips(filter: SessionFilter, now = Date.now()): FilterChip[] {
  const chips: FilterChip[] = [];
  const record = filter as Record<string, unknown>;

  const range = dateRangeShorthand(filter, now);
  if (range !== null) chips.push({ key: "from", label: `Last ${range}` });

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || key === "from" || key === "to" || key === "warehouse_version")
      continue;
    chips.push({ key, label: chipLabel(key, value) });
  }

  return chips;
}

export function removeFilterKey(filter: SessionFilter, key: string): SessionFilter {
  const next = { ...(filter as Record<string, unknown>) };
  delete next[key];
  if (key === "from") delete next["to"];
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
