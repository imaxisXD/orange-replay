import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { SessionFilter } from "@orange-replay/shared";
import { cn } from "@/lib/utils";

export function InsightDoorway({
  accent,
  detail,
  filter,
  isDemo,
  label,
  numericValue,
  projectId,
  value,
}: {
  accent?: "amber";
  detail: string;
  filter: SessionFilter;
  isDemo: boolean;
  label: string;
  numericValue: number | null | undefined;
  projectId: string;
  value: ReactNode;
}) {
  return (
    <SessionDoorway
      className="border-b border-dashed border-dash px-4.5 py-4 outline-none transition-colors duration-100 ease-out hover:bg-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-amber sm:border-r lg:border-b-0 lg:last:border-r-0 motion-reduce:transition-none"
      filter={filter}
      isDemo={isDemo}
      projectId={projectId}
    >
      <span className="block text-[11.5px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          "overview-metric-value mt-1 block text-foreground",
          accent === "amber" && numericValue != null && numericValue > 0 && "text-amber",
        )}
      >
        {value}
      </span>
      <span className="mt-1 block text-[11.5px] text-muted-foreground">{detail}</span>
    </SessionDoorway>
  );
}

export function KpiDoorway({
  detail,
  filter,
  isDemo,
  label,
  projectId,
  value,
}: {
  detail: string;
  filter: SessionFilter;
  isDemo: boolean;
  label: string;
  projectId: string;
  value: ReactNode;
}) {
  return (
    <SessionDoorway
      className="group border-b border-dashed border-dash px-4.5 py-4 outline-none transition-colors duration-100 ease-out hover:bg-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-amber sm:border-r lg:border-b-0 lg:last:border-r-0 motion-reduce:transition-none"
      filter={filter}
      isDemo={isDemo}
      projectId={projectId}
    >
      <span className="block text-[11.5px] text-muted-foreground">{label}</span>
      <span className="overview-metric-value mt-1 block text-foreground">{value}</span>
      <span className="mt-1 block text-[11.5px] text-muted-foreground">{detail}</span>
    </SessionDoorway>
  );
}

export function LiveKpiDoorway({
  active,
  detail,
  isDemo,
  label,
  projectId,
  value,
}: {
  active: boolean;
  detail: string;
  isDemo: boolean;
  label: string;
  projectId: string;
  value: ReactNode;
}) {
  return (
    <LiveDoorway
      className="group border-b border-dashed border-dash px-4.5 py-4 outline-none transition-colors duration-100 ease-out hover:bg-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-amber sm:border-r lg:border-b-0 lg:last:border-r-0 motion-reduce:transition-none"
      isDemo={isDemo}
      projectId={projectId}
    >
      <span className="block text-[11.5px] text-muted-foreground">{label}</span>
      <span
        className={cn("overview-metric-value mt-1 block text-foreground", active && "text-teal")}
      >
        {value}
      </span>
      <span className="mt-1 block text-[11.5px] text-muted-foreground">{detail}</span>
    </LiveDoorway>
  );
}

export function SessionDoorway({
  children,
  className,
  filter,
  isDemo,
  projectId,
}: {
  children: ReactNode;
  className?: string;
  filter: SessionFilter;
  isDemo: boolean;
  projectId: string;
}) {
  if (isDemo) {
    return (
      <Link className={className} search={filter} to="/demo/sessions">
        {children}
      </Link>
    );
  }

  return (
    <Link
      className={className}
      params={{ projectId }}
      search={filter}
      to="/projects/$projectId/sessions"
    >
      {children}
    </Link>
  );
}

function LiveDoorway({
  children,
  className,
  isDemo,
  projectId,
}: {
  children: ReactNode;
  className?: string;
  isDemo: boolean;
  projectId: string;
}) {
  if (isDemo) {
    return (
      <Link className={className} to="/demo/live">
        {children}
      </Link>
    );
  }

  return (
    <Link className={className} params={{ projectId }} to="/projects/$projectId/live">
      {children}
    </Link>
  );
}
