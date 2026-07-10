import type { SessionFilter } from "@orange-replay/shared";
import { validateSessionSearch } from "./session-filters";

export const sessionSortValues = ["newest", "duration", "clicks", "pages"] as const;
export type SessionSort = (typeof sessionSortValues)[number];

/**
 * URL state for the two-pane sessions view: the shared SessionFilter plus two
 * dashboard-only keys — the selected session (drives the stage) and the list
 * sort. Neither is part of the filter contract and neither renders as a chip.
 */
export interface SessionsViewSearch extends SessionFilter {
  selected?: string;
  sort?: Exclude<SessionSort, "newest">;
  /** Client-side view toggle (watched state lives in localStorage, not the API). */
  unwatched?: boolean;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function validateSessionsViewSearch(search: Record<string, unknown>): SessionsViewSearch {
  const view: SessionsViewSearch = { ...validateSessionSearch(search) };

  const selected = search["selected"];
  if (typeof selected === "string" && SESSION_ID_PATTERN.test(selected)) {
    view.selected = selected;
  }

  const sort = search["sort"];
  if (sort === "duration" || sort === "clicks" || sort === "pages") {
    view.sort = sort;
  }

  const unwatched = search["unwatched"];
  if (unwatched === true || unwatched === "1" || unwatched === "true") {
    view.unwatched = true;
  }

  return view;
}

export function sessionFilterOf(view: SessionsViewSearch): SessionFilter {
  const { selected: _selected, sort: _sort, unwatched: _unwatched, ...filter } = view;
  return filter;
}
