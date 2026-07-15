import {
  decodeProjectStatsResponse,
  encodeSessionFilter,
  type ProjectStatsResponse,
  type SessionFilter,
} from "@orange-replay/shared";
import { encodePathPart, requestJson } from "./client";

export type {
  FilteredNumber,
  FilteredOptionalNumber,
  ProjectStatsResponse,
  StatsBreakdownRow,
  StatsErrorGroup,
} from "@orange-replay/shared";

export async function fetchProjectStats(
  projectId: string,
  filter: SessionFilter,
  options: { signal?: AbortSignal } = {},
): Promise<ProjectStatsResponse> {
  return requestJson<ProjectStatsResponse>(buildStatsUrl(projectId, filter), {
    auth: true,
    decode: decodeProjectStatsResponse,
    signal: options.signal,
  });
}

export function buildStatsUrl(projectId: string, filter: SessionFilter): string {
  const query = encodeSessionFilter(filter).toString();
  const suffix = query.length === 0 ? "" : `?${query}`;
  return `/api/v1/projects/${encodePathPart(projectId)}/stats${suffix}`;
}
