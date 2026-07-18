import type { SessionFilter } from "@orange-replay/shared";
import { AnimatedDuration, AnimatedNumber } from "@/components/animated-number";
import type { ProjectStatsResponse } from "@/lib/api";
import { formatDurationWords } from "@/lib/format";
import { BreakdownCard, DeviceCard, ErrorsCard, GeoCard } from "./overview-breakdowns";
import { InsightDoorway, KpiDoorway, LiveKpiDoorway } from "./overview-doorways";
import { numberFormatter } from "./overview-format";
import { CardTitle } from "./overview-states";

const oneDecimalFormat = {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
} as const;

const percentNumberFormat = {
  maximumFractionDigits: 1,
} as const;

const wholeNumberFormat = {
  maximumFractionDigits: 0,
} as const;

export function OverviewSummary({
  filter,
  isDemo,
  projectId,
  stats,
}: {
  filter: SessionFilter;
  isDemo: boolean;
  projectId: string;
  stats: ProjectStatsResponse | undefined;
}) {
  const coveredSessions = stats?.pagesPerSession.includedSessions.value;
  const totalSessions = stats?.pagesPerSession.totalSessions.value;
  const coverageLabel = pageCoverageLabel(coveredSessions, totalSessions);

  return (
    <>
      <section
        aria-label="Key metrics"
        className="lit overview-lit grid overflow-hidden rounded-lg sm:grid-cols-2 lg:grid-cols-4"
      >
        <KpiDoorway
          filter={stats?.sessions.filter ?? filter}
          isDemo={isDemo}
          label="Sessions"
          projectId={projectId}
          value={<AnimatedNumber value={stats?.sessions.value ?? 0} />}
          detail="Completed in this time range"
        />
        <KpiDoorway
          filter={stats?.duration.average.filter ?? filter}
          isDemo={isDemo}
          label="Average session length"
          projectId={projectId}
          value={<AnimatedDuration value={stats?.duration.average.value ?? 0} />}
          detail={
            stats === undefined
              ? "Waiting for session data"
              : `Half of sessions lasted ${formatDurationWords(stats.duration.p50.value)} or less`
          }
        />
        <KpiDoorway
          filter={stats?.pagesPerSession.filter ?? filter}
          isDemo={isDemo}
          label="Pages per session"
          projectId={projectId}
          value={
            <AnimatedNumber format={oneDecimalFormat} value={stats?.pagesPerSession.value ?? 0} />
          }
          detail={coverageLabel}
        />
        <LiveKpiDoorway
          active={(stats?.liveNow.value ?? 0) > 0}
          isDemo={isDemo}
          label="Live now"
          projectId={projectId}
          value={<AnimatedNumber value={stats?.liveNow.value ?? 0} />}
          detail="Active in the last minute"
        />
      </section>

      <InsightsCard filter={filter} isDemo={isDemo} projectId={projectId} stats={stats} />
    </>
  );
}

export function OverviewContent({
  isDemo,
  projectId,
  stats,
}: {
  isDemo: boolean;
  projectId: string;
  stats: ProjectStatsResponse;
}) {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <GeoCard isDemo={isDemo} projectId={projectId} stats={stats} />
      <DeviceCard isDemo={isDemo} projectId={projectId} stats={stats} />
      <BreakdownCard
        description="Where people landed first"
        isDemo={isDemo}
        projectId={projectId}
        rows={stats.breakdowns.entryPage}
        title="Entry pages"
      />
      <ErrorsCard errors={stats.errors} isDemo={isDemo} projectId={projectId} />
    </div>
  );
}

function InsightsCard({
  filter,
  isDemo,
  projectId,
  stats,
}: {
  filter: SessionFilter;
  isDemo: boolean;
  projectId: string;
  stats: ProjectStatsResponse | undefined;
}) {
  const includedSessions = stats?.insights.includedSessions.value;
  const totalSessions = stats?.insights.totalSessions.value;
  const coverage = insightCoverageLabel(includedSessions, totalSessions);

  return (
    <section aria-label="Session behavior" className="lit overview-lit overflow-hidden rounded-lg">
      <div className="border-b border-dashed border-dash px-4 py-3.5">
        <CardTitle description={coverage} title="Session behavior" />
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4">
        <InsightDoorway
          accent="amber"
          detail="Sessions with repeated clicks in one spot"
          filter={stats?.insights.ragePercent.filter ?? filter}
          isDemo={isDemo}
          label="Rage clicks"
          numericValue={stats?.insights.ragePercent.value}
          projectId={projectId}
          value={<MetricPercentage isRatio value={stats?.insights.ragePercent.value} />}
        />
        <InsightDoorway
          accent="amber"
          detail="Returned to the previous page within 10 seconds"
          filter={stats?.insights.quickBackPercent.filter ?? filter}
          isDemo={isDemo}
          label="Quick returns"
          numericValue={stats?.insights.quickBackPercent.value}
          projectId={projectId}
          value={<MetricPercentage isRatio value={stats?.insights.quickBackPercent.value} />}
        />
        <InsightDoorway
          detail="Estimated time spent clicking, typing, or scrolling"
          filter={stats?.insights.averageInteractionTimeMs.filter ?? filter}
          isDemo={isDemo}
          label="Interaction time"
          numericValue={stats?.insights.averageInteractionTimeMs.value}
          projectId={projectId}
          value={<AnimatedDuration value={stats?.insights.averageInteractionTimeMs.value ?? 0} />}
        />
        <InsightDoorway
          detail="Average furthest point reached"
          filter={stats?.insights.averageMaxScrollDepth.filter ?? filter}
          isDemo={isDemo}
          label="Scroll depth"
          numericValue={stats?.insights.averageMaxScrollDepth.value}
          projectId={projectId}
          value={<MetricPercentage value={stats?.insights.averageMaxScrollDepth.value} />}
        />
      </div>
    </section>
  );
}

export function MetricPercentage({
  isRatio = false,
  value,
}: {
  isRatio?: boolean;
  value: number | null | undefined;
}) {
  const valueOrZero = value ?? 0;
  const displayedValue = isRatio ? valueOrZero * 100 : valueOrZero;

  return (
    <AnimatedNumber
      format={isRatio ? percentNumberFormat : wholeNumberFormat}
      suffix="%"
      value={displayedValue}
    />
  );
}

function pageCoverageLabel(
  coveredSessions: number | undefined,
  totalSessions: number | undefined,
): string {
  if (coveredSessions === undefined || totalSessions === undefined) return "Waiting for page data";
  if (coveredSessions === 0) return "No page data for these sessions";
  if (coveredSessions === totalSessions) {
    return `Based on all ${numberFormatter.format(totalSessions)} sessions`;
  }
  return `Based on ${numberFormatter.format(coveredSessions)} of ${numberFormatter.format(totalSessions)} sessions`;
}

function insightCoverageLabel(
  includedSessions: number | undefined,
  totalSessions: number | undefined,
): string {
  if (includedSessions === undefined || totalSessions === undefined) {
    return "Waiting for behavior data";
  }
  if (includedSessions === 0) return "No behavior data for these sessions";
  if (includedSessions === totalSessions) {
    return `Based on all ${numberFormatter.format(totalSessions)} sessions`;
  }
  return `Based on ${numberFormatter.format(includedSessions)} of ${numberFormatter.format(totalSessions)} sessions`;
}
