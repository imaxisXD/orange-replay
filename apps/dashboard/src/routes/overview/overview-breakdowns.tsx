import { useState } from "react";
import { CountryFlag } from "@/components/country-flag";
import { TabItem, TabPanel, Tabs, TabsList } from "@/components/ui/tabs";
import type { ProjectStatsResponse, StatsBreakdownRow, StatsErrorGroup } from "@/lib/api";
import {
  BrowserWindow,
  ComputerSettings,
  Globe,
  MapLocation,
  Monitor,
  type IconComponent,
} from "@/lib/icon-map";
import { canonicalSessionFilter } from "@/lib/session-filters";
import { SessionDoorway } from "./overview-doorways";
import { numberFormatter, percentFormatter } from "./overview-format";
import { CardEmpty, CardTitle } from "./overview-states";

type DeviceDimension = "device" | "browser" | "os";
type GeoDimension = "country" | "region";

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
        { icon: Globe, label: "Countries", value: "country" },
        { icon: MapLocation, label: "Regions", value: "region" },
      ]}
      projectId={projectId}
      rowsByValue={{
        country: stats.breakdowns.country,
        region: stats.breakdowns.region,
      }}
      showCountryFlagFor="country"
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
      description="Device, browser, and OS usage"
      isDemo={isDemo}
      onChange={(value) => setDimension(value as DeviceDimension)}
      options={[
        { icon: Monitor, label: "Device", value: "device" },
        { icon: BrowserWindow, label: "Browser", value: "browser" },
        { icon: ComputerSettings, label: "OS", value: "os" },
      ]}
      projectId={projectId}
      rowsByValue={{
        device: stats.breakdowns.device,
        browser: stats.breakdowns.browser,
        os: stats.breakdowns.os,
      }}
      title="Technology"
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
    <section className="lit overview-lit min-h-80 overflow-hidden rounded-lg">
      <div className="border-b border-dashed border-dash px-4 py-3.5">
        <CardTitle description={description} title={title} />
      </div>
      <BreakdownRows isDemo={isDemo} projectId={projectId} rows={rows} />
    </section>
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
    <section className="lit overview-lit min-h-80 overflow-hidden rounded-lg">
      <div className="border-b border-dashed border-dash px-4 py-3.5">
        <CardTitle description="Errors recorded during these sessions" title="Browser errors" />
      </div>
      {errors.length === 0 ? (
        <CardEmpty
          description="No browser errors were recorded in this time range."
          title="No browser errors"
        />
      ) : (
        <div>
          {errors.map((error) => (
            <ErrorRow error={error} isDemo={isDemo} key={error.detail} projectId={projectId} />
          ))}
        </div>
      )}
    </section>
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
  showCountryFlagFor,
  title,
}: {
  active: string;
  description: string;
  isDemo: boolean;
  onChange: (value: string) => void;
  options: { icon: IconComponent; label: string; value: string }[];
  projectId: string;
  rowsByValue: Record<string, StatsBreakdownRow[]>;
  showCountryFlagFor?: string;
  title: string;
}) {
  return (
    <section className="lit overview-lit min-h-80 overflow-hidden rounded-lg">
      <Tabs onValueChange={onChange} value={active}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-dashed border-dash px-4 py-3">
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
        </div>
        {options.map((option) => (
          <TabPanel key={option.value} value={option.value}>
            <BreakdownRows
              isDemo={isDemo}
              projectId={projectId}
              rows={rowsByValue[option.value] ?? []}
              showCountryFlag={showCountryFlagFor === option.value}
            />
          </TabPanel>
        ))}
      </Tabs>
    </section>
  );
}

function BreakdownRows({
  isDemo,
  projectId,
  rows,
  showCountryFlag = false,
}: {
  isDemo: boolean;
  projectId: string;
  rows: StatsBreakdownRow[];
  showCountryFlag?: boolean;
}) {
  if (rows.length === 0) {
    return <CardEmpty description="Try a wider time range." title="No sessions to show" />;
  }

  return (
    <div>
      {rows.map((row) => (
        <SessionDoorway
          className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-subtle-border px-4 py-3 outline-none transition-colors duration-100 ease-out last:border-b-0 hover:bg-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-amber motion-reduce:transition-none"
          filter={row.filter}
          isDemo={isDemo}
          key={`${row.label}-${canonicalSessionFilter(row.filter)}`}
          projectId={projectId}
        >
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              {showCountryFlag && <CountryFlag country={row.label} />}
              <span
                className="truncate text-[12.5px] font-medium text-foreground"
                title={row.label}
              >
                {row.label}
              </span>
            </span>
            <span className="mt-1 block h-1 overflow-hidden rounded-full bg-secondary">
              <span
                className="block h-full rounded-full bg-amber"
                style={{ width: `${Math.min(100, row.share.value * 100)}%` }}
              />
            </span>
          </span>
          <span className="text-right">
            <span className="block font-mono text-[12.5px] text-foreground">
              {numberFormatter.format(row.count.value)}
            </span>
            <span className="block font-mono text-[11px] text-dim">
              {percentFormatter.format(row.share.value)}
            </span>
          </span>
        </SessionDoorway>
      ))}
    </div>
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
        <span className="mt-0.5 block text-[11.5px] text-dim">
          {numberFormatter.format(error.affectedSessions.value)} affected sessions
        </span>
      </span>
      <span className="font-mono text-[12px] text-danger">
        {numberFormatter.format(error.count.value)} events
      </span>
    </SessionDoorway>
  );
}
