import { useEffect, useRef, type KeyboardEvent } from "react";
import { ActivitySpark } from "@/components/activity-spark";
import { CountryFlag } from "@/components/country-flag";
import { StatusPill } from "@/components/status-pill";
import type { SessionListItem } from "@/lib/api";
import { cleanCountryCode, formatLocationName } from "@/lib/country";
import {
  formatAbsoluteTime,
  formatDuration,
  formatErrorCount,
  formatShortRelativeTime,
} from "@/lib/format";
import { Smartphone } from "@/lib/icon-map";

export function SessionCard({
  isSelected,
  isWatched,
  onSelect,
  session,
}: {
  isSelected: boolean;
  isWatched: boolean;
  onSelect: () => void;
  session: SessionListItem;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const countryCode = cleanCountryCode(session.country);
  const location = formatLocationName(session.country, session.city);
  const metaParts = [location];
  const client = [session.browser, session.os].filter(Boolean).join("/");
  if (client.length > 0) metaParts.push(client);
  if (session.page_count !== null && session.page_count > 0) {
    metaParts.push(`${session.page_count} pg`);
  }

  // Deep links land with the playing session visible in the rail.
  useEffect(() => {
    if (isSelected) cardRef.current?.scrollIntoView({ block: "nearest" });
  }, [isSelected]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect();
  }

  return (
    <div
      aria-current={isSelected ? "true" : undefined}
      aria-label={cardLabel(session, location, isWatched)}
      data-session-id={session.session_id}
      className={`cursor-pointer border-b border-dashed border-dash px-4 py-3 outline-none transition-colors last:border-b-0 focus-visible:ring-2 focus-visible:ring-amber ${
        isSelected ? "bg-secondary" : "hover:bg-[#141419]"
      }`}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      ref={cardRef}
      role="link"
      tabIndex={0}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="watched-dot size-1.5 shrink-0 rounded-full bg-amber"
          data-watched={isWatched}
        />
        <span
          className={`min-w-0 flex-1 truncate text-[13px] font-medium ${
            isSelected ? "text-amber" : "text-foreground"
          }`}
        >
          {entryPath(session.entry_url)}
        </span>
        <span className="shrink-0 font-mono text-[12px] text-foreground">
          {formatDuration(session.duration_ms)}
        </span>
      </div>

      {/* Frustration pills appear only when there is something to say — a
          healthy session's signal is the absence of markers, so problem rows
          pop preattentively instead of drowning in green "clean" chips. */}
      <div className="mt-1.5 flex min-h-5 items-center gap-1.5">
        <div className="flex min-w-0 flex-1 gap-1.5">
          {session.errors > 0 && (
            <StatusPill kind="err">{formatErrorCount(session.errors)}</StatusPill>
          )}
          {session.rages > 0 && <StatusPill kind="rage">{session.rages} rage</StatusPill>}
        </div>
        <ActivitySpark hist={session.activity_hist} />
      </div>

      {/* muted-foreground, not dim: 11.5px body-adjacent text must clear WCAG AA
          (dim measures 3.19:1 on the card surface — reserved for labels). */}
      <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <CountryFlag country={countryCode} />
        {/* Exception signal, like the pills: desktop is the default and shows
            nothing; a handheld session gets a glyph worth noticing. */}
        {(session.device === "mobile" || session.device === "tablet") && (
          <Smartphone
            aria-label="Mobile device"
            className="size-3 shrink-0 text-muted-foreground"
          />
        )}
        <span className="min-w-0 flex-1 truncate">{metaParts.join(" · ")}</span>
        <span className="shrink-0" title={formatAbsoluteTime(session.started_at)}>
          {formatShortRelativeTime(session.started_at)}
        </span>
      </div>
    </div>
  );
}

function cardLabel(session: SessionListItem, location: string, isWatched: boolean): string {
  const parts = [entryPath(session.entry_url), formatDuration(session.duration_ms)];
  if (session.errors > 0) parts.push(formatErrorCount(session.errors));
  if (session.rages > 0) parts.push(`${session.rages} rage clicks`);
  parts.push(location, formatShortRelativeTime(session.started_at));
  if (!isWatched) parts.push("not watched");
  return parts.join(", ");
}

export function entryPath(value: string | null): string {
  if (value === null || value.length === 0) return "/";

  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  } catch {
    return value.startsWith("/") ? value : `/${value}`;
  }
}
