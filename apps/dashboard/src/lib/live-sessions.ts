import type { LiveSessionItem } from "@/lib/api";
import { formatDuration } from "@/lib/format";

export const livePollIntervalMs = 5_000;

export interface LiveSessionRow {
  sessionId: string;
  entryPath: string;
  placeText: string;
  elapsedTime: string;
}

export function formatLiveSessionRow(session: LiveSessionItem): LiveSessionRow {
  return {
    sessionId: session.session_id,
    entryPath: entryPath(session.entry_url),
    placeText: formatPlace(session.country, session.city, session.browser),
    elapsedTime: formatDuration(session.duration_ms),
  };
}

export function shouldPollLiveSessions(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState !== "hidden";
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
  if (countryCode.length === 0) return city.length > 0 ? city : "Unknown";
  if (!/^[A-Z]{2}$/.test(countryCode)) return city.length > 0 ? city : countryCode;

  const label = city.length > 0 ? city : countryCode;
  return `${flagForCountry(countryCode)} ${label}`;
}

function flagForCountry(code: string): string {
  const first = 0x1f1e6 + code.charCodeAt(0) - 65;
  const second = 0x1f1e6 + code.charCodeAt(1) - 65;
  return String.fromCodePoint(first, second);
}
