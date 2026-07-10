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
  numericValue: number | null;
  projectId: string;
  value: string;
}) {
  return (
    <SessionDoorway
      className="border-b border-dashed border-dash px-4.5 py-4 outline-none transition-colors duration-150 hover:bg-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-amber sm:border-r lg:border-b-0 lg:last:border-r-0 motion-reduce:transition-none"
      filter={filter}
      isDemo={isDemo}
      projectId={projectId}
    >
      <span className="block text-[11.5px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          "mt-1 block font-mono text-[21px] font-semibold tracking-[-0.02em] text-foreground tabular-nums",
          accent === "amber" && numericValue !== null && numericValue > 0 && "text-amber",
        )}
      >
        {value}
      </span>
      <span className="mt-1 block text-[11.5px] text-dim">{detail}</span>
    </SessionDoorway>
  );
}

export function KpiDoorway({
  accent,
  detail,
  filter,
  isDemo,
  label,
  projectId,
  value,
}: {
  accent?: "teal";
  detail: string;
  filter: SessionFilter;
  isDemo: boolean;
  label: string;
  projectId: string;
  value: string;
}) {
  return (
    <SessionDoorway
      className="group border-b border-dashed border-dash px-4.5 py-4 outline-none transition-colors duration-150 hover:bg-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-amber sm:border-r lg:border-b-0 lg:last:border-r-0 motion-reduce:transition-none"
      filter={filter}
      isDemo={isDemo}
      projectId={projectId}
    >
      <span className="block text-[11.5px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          "mt-1 block font-mono text-[21px] font-semibold tracking-[-0.02em] text-foreground",
          accent === "teal" && value !== "0" && "text-teal",
        )}
      >
        {value}
      </span>
      <span className="mt-1 block text-[11.5px] text-dim">{detail}</span>
    </SessionDoorway>
  );
}

export function LiveKpiDoorway({
  detail,
  isDemo,
  label,
  projectId,
  value,
}: {
  detail: string;
  isDemo: boolean;
  label: string;
  projectId: string;
  value: string;
}) {
  return (
    <LiveDoorway
      className="group border-b border-dashed border-dash px-4.5 py-4 outline-none transition-colors duration-150 hover:bg-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-amber sm:border-r lg:border-b-0 lg:last:border-r-0 motion-reduce:transition-none"
      isDemo={isDemo}
      projectId={projectId}
    >
      <span className="block text-[11.5px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          "mt-1 block font-mono text-[21px] font-semibold tracking-[-0.02em] text-foreground",
          value !== "0" && "text-teal",
        )}
      >
        {value}
      </span>
      <span className="mt-1 block text-[11.5px] text-dim">{detail}</span>
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
