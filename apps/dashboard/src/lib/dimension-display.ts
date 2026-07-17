import { cleanCountryCode } from "@/lib/country";
import {
  Android,
  Chrome,
  Linux,
  MacOs,
  Monitor,
  Safari,
  Smartphone,
  Windows,
  type IconComponent,
} from "@/lib/icon-map";

export type BreakdownDimension =
  | "browser"
  | "city"
  | "country"
  | "device"
  | "entryPage"
  | "os"
  | "region";

/** Raw stored value → display casing. The UA parser stores device lowercase
 * ("desktop"); the rest is defensive for legacy lowercase rows. Unknown
 * values pass through untouched. */
const DISPLAY_CASING: Record<string, string> = {
  android: "Android",
  chrome: "Chrome",
  desktop: "Desktop",
  edge: "Edge",
  firefox: "Firefox",
  ios: "iOS",
  linux: "Linux",
  macos: "macOS",
  mobile: "Mobile",
  safari: "Safari",
  tablet: "Tablet",
  windows: "Windows",
};

/** design-language.md §Icon vocabulary: a recognizable brand glyph beats text
 * at scan speed, so render one when the free icon set has it — and honest
 * text when it does not (Firefox, Edge, iOS, Tablet have no free glyph). */
const GLYPHS: Record<string, IconComponent> = {
  Android: Android,
  Chrome: Chrome,
  Desktop: Monitor,
  Linux: Linux,
  Mobile: Smartphone,
  Safari: Safari,
  Windows: Windows,
  macOS: MacOs,
};

let regionNames: Intl.DisplayNames | null | undefined;

/** "IN" → "India" in the viewer's locale; falls back to the code. */
function countryName(raw: string): string {
  const code = cleanCountryCode(raw);
  if (code === null) return raw;
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(undefined, { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Display treatment for a breakdown row label. The raw value stays in the
 * row's filter; only what the user reads changes. */
export function dimensionDisplay(
  dimension: BreakdownDimension,
  raw: string,
): { Icon?: IconComponent; label: string } {
  if (dimension === "country") {
    return { label: countryName(raw) };
  }
  if (dimension === "device" || dimension === "browser" || dimension === "os") {
    const label = DISPLAY_CASING[raw.toLowerCase()] ?? raw;
    const Icon = GLYPHS[label];
    return Icon === undefined ? { label } : { Icon, label };
  }
  return { label: raw };
}
