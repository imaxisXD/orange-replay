import type { ProjectStatsResponse } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { BreakdownCard, DeviceCard, ErrorsCard, GeoCard } from "./overview-breakdowns";
import { InsightDoorway, KpiDoorway, LiveKpiDoorway } from "./overview-doorways";
import {
  formatOptionalDuration,
  formatPercent,
  formatScrollDepth,
  numberFormatter,
} from "./overview-format";
import { CardTitle } from "./overview-states";

export function OverviewContent({
  isDemo,
  projectId,
  stats,
}: {
  isDemo: boolean;
  projectId: string;
  stats: ProjectStatsResponse;
}) {
  const coveredSessions = stats.pagesPerSession.includedSessions.value;
  const totalSessions = stats.pagesPerSession.totalSessions.value;
  const coverageLabel =
    coveredSessions === 0
      ? "No page coverage"
      : coveredSessions === totalSessions
        ? `All ${numberFormatter.format(totalSessions)} sessions covered`
        : `${numberFormatter.format(coveredSessions)} of ${numberFormatter.format(totalSessions)} sessions covered`;

  return (
    <>
      <section
        aria-label="Key metrics"
        className="lit grid overflow-hidden rounded-lg sm:grid-cols-2 lg:grid-cols-4"
      >
        <KpiDoorway
          filter={stats.sessions.filter}
          isDemo={isDemo}
          label="Sessions"
          projectId={projectId}
          value={numberFormatter.format(stats.sessions.value)}
          detail="Finalized in this range"
        />
        <KpiDoorway
          filter={stats.duration.average.filter}
          isDemo={isDemo}
          label="Avg duration"
          projectId={projectId}
          value={formatDuration(stats.duration.average.value)}
          detail={`P50 ${formatDuration(stats.duration.p50.value)}`}
        />
        <KpiDoorway
          filter={stats.pagesPerSession.filter}
          isDemo={isDemo}
          label="Pages / session"
          projectId={projectId}
          value={
            stats.pagesPerSession.value === null ? "—" : stats.pagesPerSession.value.toFixed(1)
          }
          detail={coverageLabel}
        />
        <LiveKpiDoorway
          isDemo={isDemo}
          label="Live now"
          projectId={projectId}
          value={numberFormatter.format(stats.liveNow.value)}
          detail="Counted from live presence"
        />
      </section>

      <InsightsCard isDemo={isDemo} projectId={projectId} stats={stats} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <GeoCard isDemo={isDemo} projectId={projectId} stats={stats} />
        <DeviceCard isDemo={isDemo} projectId={projectId} stats={stats} />
        <BreakdownCard
          description="Where these sessions started"
          isDemo={isDemo}
          projectId={projectId}
          rows={stats.breakdowns.entryPage}
          title="Entry pages"
        />
        <ErrorsCard errors={stats.errors} isDemo={isDemo} projectId={projectId} />
      </div>
    </>
  );
}

function InsightsCard({
  isDemo,
  projectId,
  stats,
}: {
  isDemo: boolean;
  projectId: string;
  stats: ProjectStatsResponse;
}) {
  const includedSessions = stats.insights.includedSessions.value;
  const totalSessions = stats.insights.totalSessions.value;
  const coverage =
    includedSessions === 0
      ? "No insight coverage yet"
      : includedSessions === totalSessions
        ? `All ${numberFormatter.format(totalSessions)} sessions covered`
        : `${numberFormatter.format(includedSessions)} of ${numberFormatter.format(totalSessions)} sessions covered`;

  return (
    <section aria-label="Insights" className="lit overflow-hidden rounded-lg">
      <div className="border-b border-dashed border-dash px-4 py-3.5">
        <CardTitle description={coverage} title="Insights" />
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4">
        <InsightDoorway
          accent="amber"
          detail="Sessions with a detected burst"
          filter={stats.insights.ragePercent.filter}
          isDemo={isDemo}
          label="Rage clicks"
          numericValue={stats.insights.ragePercent.value}
          projectId={projectId}
          value={formatPercent(stats.insights.ragePercent.value)}
        />
        <InsightDoorway
          accent="amber"
          detail="in-app · A → B → A under 10s"
          filter={stats.insights.quickBackPercent.filter}
          isDemo={isDemo}
          label="Internal quick backs"
          numericValue={stats.insights.quickBackPercent.value}
          projectId={projectId}
          value={formatPercent(stats.insights.quickBackPercent.value)}
        />
        <InsightDoorway
          detail="Average capped event gaps"
          filter={stats.insights.averageInteractionTimeMs.filter}
          isDemo={isDemo}
          label="Interaction time"
          numericValue={stats.insights.averageInteractionTimeMs.value}
          projectId={projectId}
          value={formatOptionalDuration(stats.insights.averageInteractionTimeMs.value)}
        />
        <InsightDoorway
          detail="Average session maximum"
          filter={stats.insights.averageMaxScrollDepth.filter}
          isDemo={isDemo}
          label="Max scroll depth"
          numericValue={stats.insights.averageMaxScrollDepth.value}
          projectId={projectId}
          value={formatScrollDepth(stats.insights.averageMaxScrollDepth.value)}
        />
      </div>
    </section>
  );
}
