import type { KeyboardEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CountryFlag } from "@/components/country-flag";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import type { SessionListItem } from "@/lib/api";
import { cleanCountryCode, formatLocationName } from "@/lib/country";
import { Elevated } from "@/lib/elevated";
import {
  formatAbsoluteTime,
  formatBytes,
  formatDuration,
  formatErrorCount,
  formatShortRelativeTime,
} from "@/lib/format";
import { ChevronRight } from "@/lib/icon-map";
import { useShape } from "@/lib/shape-context";

export function SessionRow({
  isDemo,
  index,
  projectId,
  session,
}: {
  isDemo: boolean;
  index: number;
  projectId: string;
  session: SessionListItem;
}) {
  const navigate = useNavigate();
  const shape = useShape();
  const countryCode = cleanCountryCode(session.country);
  const location = formatLocationName(session.country, session.city);
  const metaParts = [location];
  if (session.clicks > 0) metaParts.push(`${session.clicks} clicks`);

  function openSession(): void {
    if (isDemo) {
      void navigate({
        to: "/demo/sessions/$sessionId",
        params: { sessionId: session.session_id },
      });
      return;
    }

    void navigate({
      to: "/projects/$projectId/sessions/$sessionId",
      params: { projectId, sessionId: session.session_id },
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTableRowElement>): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openSession();
  }

  return (
    <TableRow
      className="cursor-pointer"
      index={index}
      onClick={openSession}
      onKeyDown={handleKeyDown}
      role="link"
      tabIndex={0}
    >
      <TableCell>
        <div className="max-w-75 truncate text-[13px] font-medium text-foreground">
          {entryPath(session.entry_url)}
        </div>
        <div className="mt-0.5 flex max-w-75 items-center gap-1.5 text-[11.5px] text-dim">
          <CountryFlag country={countryCode} />
          <span className="truncate">{metaParts.join(" · ")}</span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1.5">
          {session.errors > 0 && (
            <Elevated className={`inline-flex ${shape.item}`} offset={4} shadowLevel={4}>
              <Badge color="red" size="sm" variant="dot">
                {formatErrorCount(session.errors)}
              </Badge>
            </Elevated>
          )}
          {session.rages > 0 && (
            <Elevated className={`inline-flex ${shape.item}`} offset={4} shadowLevel={4}>
              <Badge color="amber" size="sm" variant="dot">
                {session.rages} rage
              </Badge>
            </Elevated>
          )}
          {session.errors === 0 && session.rages === 0 && (
            <Elevated className={`inline-flex ${shape.item}`} offset={4} shadowLevel={4}>
              <Badge color="green" size="sm" variant="dot">
                clean
              </Badge>
            </Elevated>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right font-mono text-[12px] text-foreground">
        {formatDuration(session.duration_ms)}
      </TableCell>
      <TableCell>
        <span className="font-mono text-[12px] text-muted-foreground">
          {session.browser ?? "Unknown"}
          <span className="px-1 text-dim">·</span>
          {session.os ?? "Unknown"}
        </span>
      </TableCell>
      <TableCell className="text-right font-mono text-[12px] text-muted-foreground">
        {formatBytes(session.bytes)}
      </TableCell>
      <TableCell
        className="text-right text-[12px] text-dim"
        title={formatAbsoluteTime(session.started_at)}
      >
        {formatShortRelativeTime(session.started_at)}
      </TableCell>
      <TableCell className="w-6 px-0">
        <ChevronRight
          aria-hidden
          className="size-4 text-dim opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
        />
      </TableCell>
    </TableRow>
  );
}

function entryPath(value: string | null): string {
  if (value === null || value.length === 0) return "/";

  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  } catch {
    return value.startsWith("/") ? value : `/${value}`;
  }
}
