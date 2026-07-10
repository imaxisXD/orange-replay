import { encodeSessionFilter, type SessionFilter } from "@orange-replay/shared";
import { encodePathPart, requestJson } from "./client";

export interface FilteredNumber {
  value: number;
  filter: SessionFilter;
}

export interface FilteredOptionalNumber {
  value: number | null;
  filter: SessionFilter;
}

export interface StatsBreakdownRow {
  label: string;
  filter: SessionFilter;
  count: FilteredNumber;
  share: FilteredNumber;
}

export interface StatsErrorGroup {
  detail: string;
  filter: SessionFilter;
  count: FilteredNumber;
  affectedSessions: FilteredNumber;
}

export interface ProjectStatsResponse {
  filter: SessionFilter;
  sessions: FilteredNumber;
  duration: {
    average: FilteredNumber;
    p50: FilteredNumber;
  };
  clicks: FilteredNumber;
  pagesPerSession: {
    value: number | null;
    filter: SessionFilter;
    includedSessions: FilteredNumber;
    totalSessions: FilteredNumber;
  };
  insights: {
    ragePercent: FilteredOptionalNumber;
    quickBackPercent: FilteredOptionalNumber;
    averageInteractionTimeMs: FilteredOptionalNumber;
    averageMaxScrollDepth: FilteredOptionalNumber;
    includedSessions: FilteredNumber;
    totalSessions: FilteredNumber;
  };
  liveNow: FilteredNumber;
  breakdowns: {
    country: StatsBreakdownRow[];
    region: StatsBreakdownRow[];
    device: StatsBreakdownRow[];
    browser: StatsBreakdownRow[];
    os: StatsBreakdownRow[];
    entryPage: StatsBreakdownRow[];
  };
  errors: StatsErrorGroup[];
}

export async function fetchProjectStats(
  projectId: string,
  filter: SessionFilter,
  options: { signal?: AbortSignal } = {},
): Promise<ProjectStatsResponse> {
  return requestJson<ProjectStatsResponse>(buildStatsUrl(projectId, filter), {
    auth: true,
    signal: options.signal,
  });
}

export function buildStatsUrl(projectId: string, filter: SessionFilter): string {
  const query = encodeSessionFilter(filter).toString();
  const suffix = query.length === 0 ? "" : `?${query}`;
  return `/api/v1/projects/${encodePathPart(projectId)}/stats${suffix}`;
}
