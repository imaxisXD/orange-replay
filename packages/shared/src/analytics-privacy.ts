const URL_KEY_ENDINGS = ["url", "uri", "href", "referrer", "referer"] as const;

/**
 * Removes query parameters and fragments from metadata values that are URLs.
 * The key check is case-insensitive and treats separators such as `_` and `-`
 * the same way, so names like `page_url`, `redirectUri`, and `Referrer` are
 * covered by the same privacy rule.
 */
export function cleanAnalyticsMetadataString(key: string, value: string): string | null {
  if (!isUrlMetadataKey(key) && !looksLikeUrl(value)) {
    return value;
  }

  return cleanAnalyticsUrl(value);
}

export function isUrlMetadataKey(key: string): boolean {
  const simpleKey = key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return simpleKey === "location" || URL_KEY_ENDINGS.some((ending) => simpleKey.endsWith(ending));
}

function cleanAnalyticsUrl(value: string): string | null {
  try {
    const url = new URL(value, "https://orange-replay.invalid");
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.pathname.startsWith("/") ? url.pathname : null;
  } catch {
    return null;
  }
}

function looksLikeUrl(value: string): boolean {
  const cleanValue = value.trim();
  return (
    /^(?:https?:)?\/\//i.test(cleanValue) ||
    /^(?:\.{0,2}\/|[?#])/.test(cleanValue) ||
    (/^[^\s?#]+[?#]/.test(cleanValue) && /[?&][^=&\s]+=[^\s]*/.test(cleanValue))
  );
}
