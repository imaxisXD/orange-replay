import { useEffect, useRef, type KeyboardEvent } from "react";
import { ClientLabel } from "@/components/client-label";
import { decodeActivityHist } from "@/lib/activity-hist";
import { CountryFlag } from "@/components/country-flag";
import { StatusPill } from "@/components/status-pill";
import type { SessionDisplayItem } from "@/lib/session-list";
import { cleanCountryCode, formatLocationName } from "@/lib/country";
import { entryPath } from "@/lib/entry-path";
import {
  formatAbsoluteTime,
  formatDuration,
  formatErrorCount,
  formatShortRelativeTime,
} from "@/lib/format";
import { MousePointer } from "@/lib/icon-map";
import { sessionCardEvidence, sessionCardStatus } from "./session-card-state";
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
  session: SessionDisplayItem;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const countryCode = cleanCountryCode(session.country);
  const location = formatLocationName(session.country, session.city);
  const hasClient = Boolean(session.browser) || Boolean(session.os);
  const hasExactDetails = session.details_state === "exact";
  const activity = hasExactDetails ? decodeActivityHist(session.activity_hist) : null;
  const status = sessionCardStatus(session);
  const evidence = sessionCardEvidence(session);

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
        {status === "live" ? (
          <StatusPill kind="ok">Live</StatusPill>
        ) : status === "pending" ? (
          <StatusPill kind="neutral">Final details pending</StatusPill>
        ) : (
          !isWatched && (
            /* Replaces the old unlabeled amber dot: unwatched state now says
                 what it means; watched rows show nothing. */
            <span
              className="shrink-0 rounded-full border border-[rgba(245,166,35,0.35)] bg-[rgba(245,166,35,0.08)] px-1.5 text-[10px] font-medium leading-[16px] text-[#ffd9a0]"
              title="You haven't watched this session yet"
            >
              New
            </span>
          )
        )}
      </div>

      <div className="mt-[9px] flex min-w-0 items-center gap-1.5">
        {evidence.kind === "provisional" ? (
          <span className="font-mono text-[11px] tabular-nums text-foreground">
            {formatDuration(evidence.durationMs)}
          </span>
        ) : evidence.kind === "metadata" ? (
          <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
            Metadata only — nothing to replay
          </span>
        ) : (
          <span className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            <span className="flex items-center gap-1">
              <MousePointer aria-hidden className="size-3.5 shrink-0" />
              {evidence.clicks} {evidence.clicks === 1 ? "click" : "clicks"}
            </span>
            <span className="text-dim">·</span>
            <span className="text-foreground">{formatDuration(evidence.durationMs)}</span>
          </span>
        )}
        <span className="flex-1" />
        {hasExactDetails && session.errors > 0 && (
          <StatusPill kind="err">{formatErrorCount(session.errors)}</StatusPill>
        )}
        {hasExactDetails && session.rages > 0 && (
          <StatusPill kind="rage">{session.rages} rage</StatusPill>
        )}
      </div>

      {hasExactDetails && (
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
      )}

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

function cardLabel(session: SessionDisplayItem, location: string, isWatched: boolean): string {
  const parts = [entryPath(session.entry_url), formatDuration(session.duration_ms)];
  const status = sessionCardStatus(session);
  if (status === "live") parts.push("Live");
  if (status === "pending") parts.push("Final details pending");
  if (session.details_state === "exact") {
    parts.push(sessionEvidenceLabel(session));
  }
  if (session.details_state === "exact" && session.errors > 0) {
    parts.push(formatErrorCount(session.errors));
  }
  if (session.details_state === "exact" && session.rages > 0) {
    parts.push(`${session.rages} rage clicks`);
  }
  parts.push(location, formatShortRelativeTime(session.started_at));
  if (!isWatched) parts.push("not watched");
  return parts.join(", ");
}
