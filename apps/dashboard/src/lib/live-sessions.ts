import type { SessionHead } from "@/lib/api";
import { cleanCountryCode, formatLocationName } from "./country";
import { entryPath } from "./entry-path";
import { formatDuration } from "./format";

export const livePollIntervalMs = 5_000;

export interface LiveSessionRow {
  sessionId: string;
  entryPath: string;
  countryCode: string | null;
  placeText: string;
  elapsedTime: string;
}

export function activeSessionHeads(sessions: readonly SessionHead[]): SessionHead[] {
  return sessions.filter((session) => session.activity === "live");
}

export function formatLiveSessionRow(
  session: Pick<
    SessionHead,
    "session_id" | "entry_url" | "country" | "city" | "browser" | "duration_ms"
  >,
): LiveSessionRow {
  return {
    sessionId: session.session_id,
    entryPath: entryPath(session.entry_url),
    countryCode: cleanCountryCode(session.country),
    placeText: formatPlace(session.country, session.city, session.browser),
    elapsedTime: formatDuration(session.duration_ms),
  };
}

export function shouldPollLiveSessions(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState !== "hidden";
}

function formatPlace(country: string | null, city: string | null, browser: string | null): string {
  const countryCode = country?.trim().toUpperCase() ?? "";
  const cleanCity = city?.trim() ?? "";
  const cleanBrowser = knownText(browser);
  const label = placeLabel(countryCode, cleanCity);

  if (cleanBrowser === null) return label;
  return `${label} · ${cleanBrowser}`;
}

function knownText(value: string | null): string | null {
  const cleanValue = value?.trim() ?? "";
  if (cleanValue.length === 0 || cleanValue.toLowerCase() === "unknown") return null;
  return cleanValue;
}

function placeLabel(countryCode: string, city: string): string {
  return formatLocationName(countryCode, city);
}
