import { useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import type { Transition } from "motion/react";
import { CountryFlag } from "@/components/country-flag";
import { Bar } from "@/components/charts/bar";
import { BarChart } from "@/components/charts/bar-chart";
import { useChartStable } from "@/components/charts/chart-context";
import { Grid } from "@/components/charts/grid";
import { ChartTooltip } from "@/components/charts/tooltip";
import { PatternLines } from "@/components/charts/visx-pattern";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { TabItem, TabPanel, Tabs, TabsList } from "@/components/ui/tabs";
import type { ProjectStatsResponse, StatsBreakdownRow, StatsErrorGroup } from "@/lib/api";
import {
  BrowserWindow,
  ComputerSettings,
  Global,
  MapLocation,
  Monitor,
  type IconComponent,
} from "@/lib/icon-map";
import { dimensionDisplay, type BreakdownDimension } from "@/lib/dimension-display";
import { canonicalSessionFilter } from "@/lib/session-filters";
import { OverviewCard, OverviewCardFooter, OverviewCardHeader } from "./overview-card";
import { SessionDoorway } from "./overview-doorways";
import { numberFormatter, percentFormatter } from "./overview-format";
import { CardEmpty, CardTitle } from "./overview-states";

type DeviceDimension = "device" | "browser" | "os";
type GeoDimension = "city" | "country";

const VISIBLE_ROWS = 6;
const OVERVIEW_BAR_ENTER_SPRING: Transition = {
  type: "spring",
  duration: 0.65,
  bounce: 0.12,
};

export function GeoCard({
  isDemo,
  projectId,
  stats,
}: {
  isDemo: boolean;
  projectId: string;
  stats: ProjectStatsResponse;
}) {
  const [dimension, setDimension] = useState<GeoDimension>("country");
  return (
    <TabbedBreakdownCard
      active={dimension}
      description="Where people used your product"
      isDemo={isDemo}
      onChange={(value) => setDimension(value as GeoDimension)}
      options={[
        { icon: Global, label: "Country", value: "country" },
        { icon: MapLocation, label: "City", value: "city" },
      ]}
      projectId={projectId}
      rowsByValue={{
        country: stats.breakdowns.country,
        city: stats.breakdowns.city,
      }}
      title="Locations"
    />
  );
}

export function DeviceCard({
  isDemo,
  projectId,
  stats,
}: {
  isDemo: boolean;
  projectId: string;
  stats: ProjectStatsResponse;
}) {
  const [dimension, setDimension] = useState<DeviceDimension>("device");
  return (
    <TabbedBreakdownCard
      active={dimension}
      description="What people used your product on"
      isDemo={isDemo}
      onChange={(value) => setDimension(value as DeviceDimension)}
      options={[
        { icon: Monitor, label: "Type", value: "device" },
        { icon: BrowserWindow, label: "Browser", value: "browser" },
        { icon: ComputerSettings, label: "OS", value: "os" },
      ]}
      projectId={projectId}
      rowsByValue={{
        device: stats.breakdowns.device,
        browser: stats.breakdowns.browser,
        os: stats.breakdowns.os,
      }}
      title="Devices"
    />
  );
}

export function BreakdownCard({
  description,
  isDemo,
  projectId,
  rows,
  title,
}: {
  description: string;
  isDemo: boolean;
  projectId: string;
  rows: StatsBreakdownRow[];
  title: string;
}) {
  return (
    <OverviewCard>
      <OverviewCardHeader>
        <CardTitle description={description} title={title} />
      </OverviewCardHeader>
      <BreakdownPanel
        dimension="entryPage"
        isDemo={isDemo}
        projectId={projectId}
        rows={rows}
        title={title}
      />
    </OverviewCard>
  );
}

export function ErrorsCard({
  errors,
  isDemo,
  projectId,
}: {
  errors: StatsErrorGroup[];
  isDemo: boolean;
  projectId: string;
}) {
  return (
    <OverviewCard>
      <OverviewCardHeader>
        <CardTitle description="What broke while people were there" title="Browser errors" />
      </OverviewCardHeader>
      {errors.length === 0 ? (
        <CardEmpty
          description="No browser errors were recorded in this time range."
          title="No browser errors"
        />
      ) : (
        <>
          <div>
            {errors.slice(0, VISIBLE_ROWS).map((error) => (
              <ErrorRow error={error} isDemo={isDemo} key={error.detail} projectId={projectId} />
            ))}
          </div>
          {errors.length > VISIBLE_ROWS && (
            <ViewAllFooter
              count={errors.length}
              description="Ranked by error events in this time range."
              title="Browser errors"
            >
              {errors.map((error) => (
                <ErrorRow error={error} isDemo={isDemo} key={error.detail} projectId={projectId} />
              ))}
            </ViewAllFooter>
          )}
        </>
      )}
    </OverviewCard>
  );
}

function TabbedBreakdownCard({
  active,
  description,
  isDemo,
  onChange,
  options,
  projectId,
  rowsByValue,
  title,
}: {
  active: string;
  description: string;
  isDemo: boolean;
  onChange: (value: string) => void;
  options: { icon: IconComponent; label: string; value: BreakdownDimension }[];
  projectId: string;
  rowsByValue: Record<string, StatsBreakdownRow[]>;
  title: string;
}) {
  return (
    <OverviewCard>
      <Tabs className="flex flex-1 flex-col" onValueChange={onChange} value={active}>
        <OverviewCardHeader className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <CardTitle description={description} title={title} />
          <TabsList surfaceLevel={5}>
            {options.map((option) => (
              <TabItem
                icon={option.icon}
                key={option.value}
                label={option.label}
                value={option.value}
              />
            ))}
          </TabsList>
        </OverviewCardHeader>
        {options.map((option) => (
          <TabPanel className="flex flex-1 flex-col" key={option.value} value={option.value}>
            <BreakdownPanel
              dimension={option.value}
              isDemo={isDemo}
              projectId={projectId}
              rows={rowsByValue[option.value] ?? []}
              title={`${title} · ${option.label}`}
            />
          </TabPanel>
        ))}
      </Tabs>
    </OverviewCard>
  );
}

/** Card body for a breakdown list: the top rows, plus a pinned "view all"
 * footer once the list outgrows the card. Composes inside OverviewCard (or a
 * TabPanel that continues the card's flex column). */
function BreakdownPanel({
  dimension,
  isDemo,
  projectId,
  rows,
  title,
}: {
  dimension: BreakdownDimension;
  isDemo: boolean;
  projectId: string;
  rows: StatsBreakdownRow[];
  title: string;
}) {
  if (rows.length === 0) {
    return <CardEmpty description="Try a wider time range." title="No sessions to show" />;
  }

  const maxCount = Math.max(1, ...rows.map((row) => row.count.value));
  const visibleRows = rows.slice(0, VISIBLE_ROWS);

  return (
    <>
      <BreakdownChart
        dimension={dimension}
        fillAvailableHeight
        isDemo={isDemo}
        maxCount={maxCount}
        projectId={projectId}
        rows={visibleRows}
        title={title}
      />
      {rows.length > VISIBLE_ROWS && (
        <ViewAllFooter
          count={rows.length}
          description="Ranked by sessions in this time range."
          title={title}
        >
          <BreakdownChart
            dimension={dimension}
            isDemo={isDemo}
            maxCount={maxCount}
            projectId={projectId}
            rows={rows}
            title={title}
          />
        </ViewAllFooter>
      )}
    </>
  );
}

/** Pinned card footer with a "View all" trigger that opens the full list in
 * a modal. `children` is the complete row list the modal shows. */
function ViewAllFooter({
  children,
  count,
  description,
  title,
}: {
  children: ReactNode;
  count: number;
  description: string;
  title: string;
}) {
  return (
    <OverviewCardFooter>
      <Dialog>
        <DialogTrigger className="flex h-8 w-full items-center justify-center rounded-[4px] font-mono text-[11px] text-muted-foreground outline-none transition-colors duration-100 ease-out hover:bg-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-amber motion-reduce:transition-none">
          View all {numberFormatter.format(count)}
        </DialogTrigger>
        <DialogContent className="max-h-[80svh] p-0">
          <DialogHeader className="border-b border-dashed border-dash px-4 py-3.5">
            <DialogTitle className="text-[13px]">{title}</DialogTitle>
            <DialogDescription className="text-[11.5px] leading-normal">
              {description}
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-y-auto py-1.5">{children}</div>
        </DialogContent>
      </Dialog>
    </OverviewCardFooter>
  );
}

interface BreakdownChartDatum extends Record<string, unknown> {
  /** Stable identity for the band scale. City labels can repeat across countries. */
  categoryKey: string;
  count: number;
  /** ISO country code carried by city rows for their flag. */
  country?: string;
  filter: StatsBreakdownRow["filter"];
  name: string;
  rawLabel: string;
  share: number;
}

function BreakdownChart({
  dimension,
  fillAvailableHeight = false,
  isDemo,
  maxCount,
  projectId,
  rows,
  title,
}: {
  dimension: BreakdownDimension;
  fillAvailableHeight?: boolean;
  isDemo: boolean;
  maxCount: number;
  projectId: string;
  rows: StatsBreakdownRow[];
  title: string;
}) {
  const navigate = useNavigate();
  const patternId = `overview-bars-${useId()}`;
  const [chartContainer, setChartContainer] = useState<HTMLDivElement | null>(null);
  const chartData: BreakdownChartDatum[] = rows.map((row) => ({
    categoryKey: canonicalSessionFilter(row.filter),
    count: row.count.value,
    ...(row.country === undefined ? {} : { country: row.country }),
    filter: row.filter,
    name: dimensionDisplay(dimension, row.label).label,
    rawLabel: row.label,
    share: row.share.value,
  }));

  function openMatchingSessions(point: Record<string, unknown>) {
    const datum = point as BreakdownChartDatum;
    if (isDemo) {
      void navigate({ search: datum.filter, to: "/demo/sessions" });
      return;
    }
    void navigate({
      params: { projectId },
      search: datum.filter,
      to: "/projects/$projectId/sessions",
    });
  }

  const aspectRatio = fillAvailableHeight ? "auto" : `${9 / Math.max(1, chartData.length)} / 1`;

  return (
    <div
      className={fillAvailableHeight ? "relative min-h-32 flex-1" : "relative"}
      ref={setChartContainer}
    >
      <BarChart
        animationDuration={1100}
        ariaLabel={`${title} breakdown`}
        aspectRatio={aspectRatio}
        barGap={0.2}
        barWidth={30}
        className={fillAvailableHeight ? "h-full min-h-0" : "min-h-32"}
        data={chartData}
        dataPointAriaLabel={(point) => {
          const datum = point as BreakdownChartDatum;
          const sessionLabel = datum.count === 1 ? "session" : "sessions";
          return `${datum.name}: ${numberFormatter.format(datum.count)} ${sessionLabel}, ${percentFormatter.format(datum.share)} of total. Open matching sessions.`;
        }}
        enterTransition={OVERVIEW_BAR_ENTER_SPRING}
        margin={{ top: 8, right: 16, bottom: 8, left: 16 }}
        minimumCategorySlots={2}
        onDataPointClick={openMatchingSessions}
        orientation="horizontal"
        valueMax={maxCount}
        xDataKey="categoryKey"
      >
        <Grid horizontal={false} vertical fadeVertical />
        {/* Fine stripes on the calm-teal token hue (181.912 — the landing
            page's brand accent): a narrow line with more card showing through
            each gap, no body fill, no border. The overlay text keeps its dark
            halo so labels and counts read on the stripes. */}
        <PatternLines
          height={8}
          id={patternId}
          orientation={["diagonal"]}
          stroke="oklch(0.42 0.05 181.912)"
          strokeWidth={2}
          width={8}
        />
        <Bar dataKey="count" fill={`url(#${patternId})`} lineCap={4} stroke="var(--teal)" />
        <OverviewChartLabels container={chartContainer} data={chartData} dimension={dimension} />
        <ChartTooltip
          rows={(point) => [
            {
              color: "var(--teal)",
              label: "Sessions",
              value: Number(point["count"] ?? 0),
            },
            {
              color: "var(--muted-foreground)",
              label: "Share",
              value: percentFormatter.format(Number(point["share"] ?? 0)),
            },
          ]}
          showCrosshair={false}
          showDatePill={false}
          showDots={false}
        />
      </BarChart>
    </div>
  );
}

function OverviewChartLabels({
  container,
  data,
  dimension,
}: {
  container: HTMLDivElement | null;
  data: BreakdownChartDatum[];
  dimension: BreakdownDimension;
}) {
  const { bandWidth, barScale, margin } = useChartStable();
  if (!(container && barScale && bandWidth !== undefined)) {
    return null;
  }

  return createPortal(
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {data.map((datum) => {
        const top = (barScale(datum.categoryKey) ?? 0) + margin.top;
        const { Icon, label } = dimensionDisplay(dimension, datum.rawLabel);
        return (
          // One overlay per row, spanning the whole bar track: label sits ON
          // the bar's left edge, count on its right — the bar runs beneath.
          // The tight dark text-shadow is a per-glyph clear zone so the hatch
          // lines never cut through letterforms.
          <div
            className="absolute flex items-center justify-between gap-3 overflow-hidden px-2.5 [text-shadow:0_1px_2px_oklch(0_0_0/0.9),0_0_6px_oklch(0_0_0/0.55)]"
            key={datum.categoryKey}
            style={{ height: bandWidth, left: margin.left, right: margin.right, top }}
          >
            <span className="flex min-w-0 items-center gap-2">
              {dimension === "country" && <CountryFlag country={datum.rawLabel} />}
              {dimension === "city" && datum.country !== undefined && (
                <CountryFlag country={datum.country} />
              )}
              {Icon !== undefined && (
                <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
              )}
              <span className="truncate text-[12.5px] font-medium text-foreground">{label}</span>
            </span>
            <span className="shrink-0 font-mono text-[12px] tabular-nums text-foreground">
              {numberFormatter.format(datum.count)}
            </span>
          </div>
        );
      })}
    </div>,
    container,
  );
}

function ErrorRow({
  error,
  isDemo,
  projectId,
}: {
  error: StatsErrorGroup;
  isDemo: boolean;
  projectId: string;
}) {
  return (
    <SessionDoorway
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-subtle-border px-4 py-3 outline-none transition-colors duration-100 ease-out last:border-b-0 hover:bg-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-amber motion-reduce:transition-none"
      filter={error.filter}
      isDemo={isDemo}
      projectId={projectId}
    >
      <span className="min-w-0">
        <span
          className="block truncate text-[12.5px] font-medium text-foreground"
          title={error.detail}
        >
          {error.detail}
        </span>
        <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
          {numberFormatter.format(error.affectedSessions.value)} affected sessions
        </span>
      </span>
      <span className="font-mono text-[12px] text-danger">
        {numberFormatter.format(error.count.value)} events
      </span>
    </SessionDoorway>
  );
}
