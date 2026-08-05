import {
  PROJECT_NAME_MAX_CHARS,
  WEBSITE_URL_ISSUE,
  websiteAllowedOrigins,
  websiteNameFromUrl,
  websiteUrlSchema,
} from "@orange-replay/shared";
export { websiteFaviconUrl } from "@/lib/website-identity";

/**
 * Pure website-identity helpers for activation. The first onboarding step turns
 * one typed URL into three things: the project name, the preview label that
 * follows every keystroke, and the ingest origin allowlist.
 */

/** Parses common website input into the canonical URL activation can use. */
export function readWebsiteUrl(value: string): URL | null {
  const parsed = websiteUrlSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The field error for a typed value, or "" while it is empty or usable. The
 * over-long hostname gets its own sentence: telling someone to "use a full
 * address" when they already typed one is a dead end.
 */
export function websiteUrlError(value: string): string {
  if (value.trim().length === 0 || readWebsiteUrl(value) !== null) return "";
  const parsed = websiteUrlSchema.safeParse(value);
  return !parsed.success &&
    parsed.error.issues.some((issue) => issue.message === WEBSITE_URL_ISSUE.projectNameTooLong)
    ? `That address is too long to name a project. Use ${PROJECT_NAME_MAX_CHARS} characters or fewer.`
    : "Enter a website like example.com or https://www.example.com.";
}

/** The project name a valid website URL becomes: its bare hostname. */
export function websiteProjectName(url: URL): string {
  return websiteNameFromUrl(url);
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
 * Website identity the preview should follow. Step one mirrors only the live
 * field, so clearing it cannot revive a previously saved name or favicon.
 * Later steps have no website field and may use the saved project identity.
 */
export function websitePreviewSource(
  websiteDraft: string,
  savedWebsiteName: string | null,
  allowSavedWebsite: boolean,
): string {
  if (websiteDraft.trim().length > 0) return websiteDraft;
  return allowSavedWebsite ? (savedWebsiteName ?? "") : "";
}

/**
 * The ingest allowlist a website URL earns. Both the typed origin and its
 * www sibling are allowed: the recorder is rejected on an exact origin match,
 * and a site reached at one spelling routinely serves pages from the other. A
 * one-entry list would make the verification step wait for an event the ingest
 * path had already refused.
 */
export function activationAllowedOrigins(url: URL): string[] {
  return websiteAllowedOrigins(url);
}

/** True when a stored project name already looks like an activated website. */
export function isWebsiteProjectName(name: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name);
}
