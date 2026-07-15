import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { SessionFilter } from "@orange-replay/shared";
import { AnalyticsStaleAlert } from "@/components/analytics-stale-alert";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { fetchProjectStats } from "@/lib/api";
import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import {
  canonicalSessionFilter,
  dateRangeFilter,
  dateRangeOptions,
  selectedDateRange,
  withDefaultDateRange,
  type DateRangeValue,
} from "@/lib/session-filters";
import { OverviewContent, OverviewSummary } from "./overview/overview-content";
import { OverviewLoading, StatsError } from "./overview/overview-states";

export function OverviewPage() {
  const { isDemo, projectId } = useDashboardWorkspace();
  const search = useSearch({ strict: false }) as SessionFilter;
  const navigate = useNavigate();
  const [initialNow] = useState(() => Date.now());
  const filter = withDefaultDateRange(search, initialNow);
  const range = selectedDateRange(filter);

  const statsQuery = useQuery({
    queryKey: [
      "project-stats",
      isDemo ? "demo" : "private",
      projectId,
      canonicalSessionFilter(filter),
    ],
    queryFn: ({ signal }) => fetchProjectStats(projectId, filter, { signal }),
  });

  function changeDateRange(value: string): void {
    const nextFilter = dateRangeFilter(filter, value as DateRangeValue, Date.now());
    if (isDemo) {
      void navigate({ to: "/demo/overview", search: nextFilter, replace: true });
      return;
    }
    void navigate({
      to: "/projects/$projectId/overview",
      params: { projectId },
      search: nextFilter,
      replace: true,
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[18px] font-semibold leading-[1.1] tracking-[-0.015em]">Overview</h1>
          <p className="mt-1 text-[12px] leading-normal text-muted-foreground">
            See completed sessions and how people used your product.
          </p>
        </div>
        <Select onValueChange={changeDateRange} value={range === "custom" ? undefined : range}>
          <SelectTrigger
            aria-label="Date range"
            className="h-8.5 min-w-35 rounded-lg border border-border bg-card px-3 text-[12px]"
            placeholder={range === "custom" ? "Custom range" : "Last 24h"}
          />
          <SelectContent className="rounded-lg border border-border bg-popover">
            <SelectGroup>
              {dateRangeOptions.map((option, index) => (
                <SelectItem index={index} key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {statsQuery.data?.analyticsState === "stale" && <AnalyticsStaleAlert />}

      {(statsQuery.data !== undefined || !statsQuery.isError) && (
        <OverviewSummary
          filter={filter}
          isDemo={isDemo}
          projectId={projectId}
          stats={statsQuery.data}
        />
      )}

      {statsQuery.isPending ? (
        <OverviewLoading />
      ) : statsQuery.isError ? (
        <StatsError error={statsQuery.error} />
      ) : (
        <OverviewContent isDemo={isDemo} projectId={projectId} stats={statsQuery.data} />
      )}
    </div>
  );
}
