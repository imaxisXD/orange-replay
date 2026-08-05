import * as v from "valibot";
import { PROJECT_NAME_MAX_CHARS } from "./project-contract.ts";
import { sharedSchema } from "./validation.ts";

const EXPLICIT_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
const DOMAIN_LABEL = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;

/** Bump when browsers and edge caches must stop serving an older favicon result. */
export const FAVICON_API_VERSION = "3";

export const WEBSITE_URL_ISSUE = {
  invalid: "invalid_website",
  projectNameTooLong: "website_name_too_long",
} as const;

/**
 * The one website-address contract used by the dashboard and Worker. A missing
 * scheme means HTTPS. The output is the canonical URL used for project naming,
 * origin access, favicon identity, and cache keys.
 */
export const websiteUrlSchema = sharedSchema(
  v.pipe(
    v.string(),
    v.rawTransform(({ dataset, addIssue, NEVER }): URL => {
      const parsed = parseWebsiteUrl(dataset.value);
      if (!parsed.ok) {
        addIssue({ message: parsed.issue });
        return NEVER;
      }
      return parsed.url;
    }),
  ),
);

function parseWebsiteUrl(value: string): { ok: true; url: URL } | { ok: false; issue: string } {
  const cleanValue = value.trim();
  if (cleanValue.length === 0 || cleanValue.length > 2_048 || /\s/.test(cleanValue)) {
    return { ok: false, issue: WEBSITE_URL_ISSUE.invalid };
  }

  const withScheme = cleanValue.startsWith("//")
    ? `https:${cleanValue}`
    : EXPLICIT_SCHEME.test(cleanValue)
      ? cleanValue
      : `https://${cleanValue}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, issue: WEBSITE_URL_ISSUE.invalid };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, issue: WEBSITE_URL_ISSUE.invalid };
  }
  if (url.username.length > 0 || url.password.length > 0 || url.hostname.length === 0) {
    return { ok: false, issue: WEBSITE_URL_ISSUE.invalid };
  }

  const hostname = url.hostname.replace(/\.$/, "");
  const isIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
  const isIpv6 = hostname.startsWith("[") && hostname.endsWith("]");
  const isLocalhost = hostname === "localhost" || hostname.endsWith(".localhost");
  const labels = hostname.split(".");
  const isDomain = labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label));

  if (!isIpv4 && !isIpv6 && !isLocalhost && !isDomain) {
    return { ok: false, issue: WEBSITE_URL_ISSUE.invalid };
  }
  if (websiteNameFromUrl(url).length > PROJECT_NAME_MAX_CHARS) {
    return { ok: false, issue: WEBSITE_URL_ISSUE.projectNameTooLong };
  }
  return { ok: true, url };
}

/** The display name saved for a normalized website URL. */
export function websiteNameFromUrl(url: URL): string {
  return url.hostname.replace(/^www\./i, "").replace(/\.$/, "");
}

/** Exact browser origins accepted by one Website recorder key. */
export function websiteAllowedOrigins(url: URL): string[] {
  const origins = [url.origin];
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.startsWith("[")) {
    return origins;
  }

  const sibling = new URL(url.origin);
  sibling.hostname = hostname.startsWith("www.") ? hostname.slice(4) : `www.${hostname}`;
  if (sibling.origin !== url.origin) origins.push(sibling.origin);
  return origins;
}
