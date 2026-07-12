import { useEffect, useRef, type KeyboardEvent } from "react";
import { ClientLabel } from "@/components/client-label";
import { decodeActivityHist } from "@/lib/activity-hist";
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
import { MousePointer } from "@/lib/icon-map";
import { sessionEvidenceLabel } from "./session-evidence";

export function SessionCard({
  isSelected,
  isTabStop,
  isWatched,
  onSelect,
  session,
}: {
  isSelected: boolean;
  isTabStop: boolean;
  isWatched: boolean;
  onSelect: () => void;
  session: SessionListItem;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const countryCode = cleanCountryCode(session.country);
  const location = formatLocationName(session.country, session.city);
  const hasClient = Boolean(session.browser) || Boolean(session.os);
  const activity = decodeActivityHist(session.activity_hist);

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
      aria-label={cardLabel(session, location, isWatched)}
      aria-selected={isSelected}
      data-session-id={session.session_id}
      className={`flex cursor-pointer flex-col border-b border-dashed border-dash px-4 py-[15px] text-left outline-none transition-colors last:border-b-0 focus-visible:ring-2 focus-visible:ring-amber ${
        isSelected ? "bg-secondary" : "hover:bg-[#141419]"
      }`}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      ref={cardRef}
      role="option"
      tabIndex={isTabStop ? 0 : -1}
    >
      <div className="flex items-center gap-2">
        <span
          className={`min-w-0 flex-1 truncate text-[13px] font-medium ${
            isSelected ? "text-amber" : "text-foreground"
          }`}
        >
          {entryPath(session.entry_url)}
        </span>
        {!isWatched && (
          /* Replaces the old unlabeled amber dot: unwatched state now says
                 what it means; watched rows show nothing. */
          <span
            className="shrink-0 rounded-full border border-[rgba(245,166,35,0.35)] bg-[rgba(245,166,35,0.08)] px-1.5 text-[10px] font-medium leading-[16px] text-[#ffd9a0]"
            title="You haven't watched this session yet"
          >
            New
          </span>
        )}
      </div>

      <div className="mt-[9px] flex min-w-0 items-center gap-1.5">
        {session.segment_count === 0 ? (
          <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
            Metadata only — nothing to replay
          </span>
        ) : (
          <span className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            <span className="flex items-center gap-1">
              <MousePointer aria-hidden className="size-3.5 shrink-0" />
              {session.clicks} {session.clicks === 1 ? "click" : "clicks"}
            </span>
            <span className="text-dim">·</span>
            <span className="text-foreground">{formatDuration(session.duration_ms)}</span>
          </span>
        )}
        <span className="flex-1" />
        {session.errors > 0 && (
          <StatusPill kind="err">{formatErrorCount(session.errors)}</StatusPill>
        )}
        {session.rages > 0 && <StatusPill kind="rage">{session.rages} rage</StatusPill>}
      </div>

      <div aria-hidden className="mt-[9px] flex h-[3px] items-stretch gap-[2px]">
        {activity === null ? (
          <div className="h-full w-full rounded-[1px] bg-[#17171c]" />
        ) : (
          activity.levels.map((level, index) => (
            <div
              className="h-full w-full rounded-[1px]"
              key={index}
              style={{
                backgroundColor:
                  activity.errors[index] === true
                    ? "#f4534e"
                    : `rgba(148, 148, 163, ${(0.1 + 0.75 * (level / 15)).toFixed(3)})`,
              }}
            />
          ))
        )}
      </div>

      <div className="mt-[9px] flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <CountryFlag country={countryCode} />
        <span className="min-w-0 truncate">{location}</span>
        {hasClient && (
          <>
            <span className="text-dim">·</span>
            <ClientLabel browser={session.browser} os={session.os} />
          </>
        )}
        <span className="flex-1" />
        <span
          className="shrink-0 font-mono text-[11px]"
          title={formatAbsoluteTime(session.started_at)}
        >
          {formatShortRelativeTime(session.started_at)}
        </span>
      </div>
    </div>
  );
}

function cardLabel(session: SessionListItem, location: string, isWatched: boolean): string {
  const parts = [
    entryPath(session.entry_url),
    formatDuration(session.duration_ms),
    sessionEvidenceLabel(session),
  ];
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
