import { PROJECT_NAME_MAX_CHARS } from "@orange-replay/shared";

/**
 * Pure website-identity helpers for activation. The first onboarding step turns
 * one typed URL into three things: the project name, the preview label that
 * follows every keystroke, and the ingest origin allowlist.
 */

/** Parses a typed value into an http(s) URL, ignoring activation's own rules. */
function parseHttpUrl(value: string): URL | null {
  const cleanValue = value.trim();
  if (cleanValue.length === 0) return null;
  try {
    const url = new URL(cleanValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname.length === 0) return null;
    return url;
  } catch {
    return null;
  }
}

/** Parses a typed value into a URL activation can actually use, or null. */
export function readWebsiteUrl(value: string): URL | null {
  const url = parseHttpUrl(value);
  if (url === null) return null;
  // The hostname becomes the project name, which the rename route bounds at
  // PROJECT_NAME_MAX_CHARS. Rejecting it here means Continue is never enabled
  // for a name the API will refuse, which would otherwise be a dead end: the
  // field looked valid and its only action returned invalid_project_name.
  if (websiteProjectName(url).length > PROJECT_NAME_MAX_CHARS) return null;
  return url;
}

/**
 * The field error for a typed value, or "" while it is empty or usable. The
 * over-long hostname gets its own sentence: telling someone to "use a full
 * address" when they already typed one is a dead end.
 */
export function websiteUrlError(value: string): string {
  if (value.trim().length === 0 || readWebsiteUrl(value) !== null) return "";
  return parseHttpUrl(value) === null
    ? "Use a full address, like https://example.com."
    : `That address is too long to name a project. Use ${PROJECT_NAME_MAX_CHARS} characters or fewer.`;
}

/** The project name a valid website URL becomes: its bare hostname. */
export function websiteProjectName(url: URL): string {
  return url.hostname.replace(/^www\./i, "");
}

/**
 * The label the dashboard preview shows while the field is still being typed.
 * It tracks partial input so the project switcher animates per keystroke, and
 * falls back to the placeholder identity when nothing usable is there yet.
 */
export function websitePreviewLabel(value: string, fallback: string): string {
  const url = readWebsiteUrl(value);
  if (url !== null) return websiteProjectName(url);

  const typedHost = value
    .trim()
    .replace(/^[a-z]*:?\/*/i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/, 1)[0];
  return typedHost === undefined || typedHost.length === 0 ? fallback : typedHost;
}

/**
 * The ingest allowlist a website URL earns. Both the typed origin and its
 * www sibling are allowed: the recorder is rejected on an exact origin match,
 * and a site reached at one spelling routinely serves pages from the other. A
 * one-entry list would make the verification step wait for an event the ingest
 * path had already refused.
 */
export function activationAllowedOrigins(url: URL): string[] {
  const origins = [url.origin];
  const sibling = new URL(url.origin);
  sibling.hostname = /^www\./i.test(url.hostname)
    ? url.hostname.replace(/^www\./i, "")
    : `www.${url.hostname}`;
  if (sibling.origin !== url.origin) origins.push(sibling.origin);
  return origins;
}

/** True when a stored project name already looks like an activated website. */
export function isWebsiteProjectName(name: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name);
}
