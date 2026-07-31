import { websiteNameFromUrl, websiteUrlSchema, type WideEventLogger } from "@orange-replay/shared";
import type { Env } from "../env.ts";
import { jsonError } from "../http.ts";

const CACHE_VERSION = "1";
const FAVICON_CACHE_SECONDS = 7 * 24 * 60 * 60;
const FALLBACK_CACHE_SECONDS = 60 * 60;
const MAX_HTML_BYTES = 256 * 1_024;
const MAX_IMAGE_BYTES = 512 * 1_024;
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_ICON_CANDIDATES = 8;

const ALLOWED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);

interface FaviconCandidate {
  href: string;
  score: number;
}

/**
 * Authenticated favicon proxy used by onboarding. It keeps third-party fetches
 * off the browser, bounds every response, validates every redirect, and stores
 * the final image in Cloudflare's local edge cache.
 */
export async function getFavicon(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  userId: string,
  wideEvent: WideEventLogger,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const parsedWebsite = websiteUrlSchema.safeParse(requestUrl.searchParams.get("website") ?? "");
  if (!parsedWebsite.success) return jsonError("invalid_website", 400);
  const website = parsedWebsite.data;

  const cacheKey = new Request(
    `${requestUrl.origin}/api/v1/favicon?website=${encodeURIComponent(website.origin)}&v=${CACHE_VERSION}`,
  );
  const cache = defaultCache();
  const cached = await readCachedFavicon(cache, cacheKey);
  if (cached !== undefined) {
    wideEvent.set({ cache_hit: true, favicon_result: "cached" });
    return cached;
  }

  wideEvent.set({ cache_hit: false });
  if (env.FAVICON_RATE_LIMITER === undefined) {
    wideEvent.set({ rate_limit: "favicon_missing" });
    return jsonError("favicon_unavailable", 503);
  }
  let rateLimit: { success: boolean };
  try {
    rateLimit = await env.FAVICON_RATE_LIMITER.limit({ key: `user:${userId}` });
  } catch {
    wideEvent.set({ rate_limit: "favicon_unavailable" });
    return jsonError("favicon_unavailable", 503);
  }
  if (!rateLimit.success) {
    wideEvent.set({ rate_limit: "favicon" });
    return jsonError("rate_limited", 429, { "retry-after": "60" });
  }

  let response: Response;
  if (!isSafePublicUrl(website)) {
    response = fallbackFavicon(website, "unsafe_target");
  } else {
    const favicon = await fetchWebsiteFavicon(website);
    response = favicon ?? fallbackFavicon(website, "not_found");
  }

  wideEvent.set({ favicon_result: response.headers.get("x-favicon-result") ?? "unknown" });
  if (cache !== null) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
  }
  return response;
}

async function fetchWebsiteFavicon(website: URL): Promise<Response | null> {
  const page = await fetchBounded(website, "text/html,application/xhtml+xml", MAX_HTML_BYTES);
  const finalPageUrl = page?.url ?? website;
  const candidates = page === null ? [] : faviconCandidates(page.bytes, finalPageUrl);
  const defaultIconHref = new URL("/favicon.ico", finalPageUrl).href;
  candidates.push({ href: defaultIconHref, score: 0 });

  const seen = new Set<string>();
  let declaredIconAttempts = 0;
  for (const candidate of candidates) {
    if (seen.has(candidate.href)) continue;
    seen.add(candidate.href);
    const isDefaultIcon = candidate.href === defaultIconHref;
    if (!isDefaultIcon && declaredIconAttempts >= MAX_ICON_CANDIDATES) continue;
    if (!isDefaultIcon) declaredIconAttempts += 1;
    const image = await fetchBounded(new URL(candidate.href), "image/*", MAX_IMAGE_BYTES);
    if (image === null) continue;

    const contentType = normalizedContentType(image.contentType, image.bytes);
    if (contentType === null || !imageBytesMatchType(image.bytes, contentType)) continue;

    return new Response(image.bytes, {
      headers: faviconHeaders(contentType, FAVICON_CACHE_SECONDS, "fetched"),
    });
  }
  return null;
}

function faviconCandidates(htmlBytes: Uint8Array, pageUrl: URL): FaviconCandidate[] {
  const html = new TextDecoder().decode(htmlBytes);
  const baseTag = html.match(/<base\b[^>]*>/i)?.[0];
  const baseHref = baseTag === undefined ? null : htmlAttribute(baseTag, "href");
  let baseUrl = pageUrl;
  if (baseHref !== null) {
    try {
      const resolved = new URL(baseHref, pageUrl);
      if (isSafePublicUrl(resolved)) baseUrl = resolved;
    } catch {
      // An invalid base URL does not make otherwise valid icon links unusable.
    }
  }

  const candidates: FaviconCandidate[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = (htmlAttribute(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("icon") && !rel.includes("apple-touch-icon")) continue;
    const href = htmlAttribute(tag, "href");
    if (href === null || href.startsWith("data:")) continue;

    try {
      const url = new URL(href, baseUrl);
      if (!isSafePublicUrl(url)) continue;
      candidates.push({
        href: url.href,
        score: candidateScore(htmlAttribute(tag, "sizes"), htmlAttribute(tag, "type")),
      });
    } catch {
      // Ignore one malformed link and continue to the next declared icon.
    }
  }
  return candidates.sort((left, right) => right.score - left.score);
}

function candidateScore(sizes: string | null, type: string | null): number {
  const normalizedType = type?.toLowerCase().split(";", 1)[0]?.trim();
  if (normalizedType === "image/svg+xml" || sizes?.toLowerCase() === "any") return 10_000;
  const declaredSizes = [...(sizes ?? "").matchAll(/(\d+)x(\d+)/gi)].map((match) =>
    Math.min(Number(match[1]), Number(match[2])),
  );
  return declaredSizes.length === 0 ? 32 : Math.max(...declaredSizes);
}

function htmlAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = pattern.exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

async function fetchBounded(
  initialUrl: URL,
  accept: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; contentType: string | null; url: URL } | null> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!isSafePublicUrl(url)) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { accept, "user-agent": "Orange-Replay-Favicon/1.0" },
        redirect: "manual",
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (location === null || redirects === MAX_REDIRECTS) return null;
        try {
          url = new URL(location, url);
        } catch {
          return null;
        }
        continue;
      }
      if (!response.ok || response.body === null) return null;

      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body.cancel();
        return null;
      }
      const bytes = await readBodyCapped(response.body, maxBytes);
      if (bytes === null) return null;
      return { bytes, contentType: response.headers.get("content-type"), url };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

async function readBodyCapped(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
  } catch {
    return null;
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizedContentType(header: string | null, bytes: Uint8Array): string | null {
  const declared = header?.toLowerCase().split(";", 1)[0]?.trim();
  if (declared !== undefined && ALLOWED_IMAGE_TYPES.has(declared)) return declared;
  if (hasBytes(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (new TextDecoder().decode(bytes.slice(0, 256)).toLowerCase().includes("<svg")) {
    return "image/svg+xml";
  }
  return null;
}

function imageBytesMatchType(bytes: Uint8Array, type: string): boolean {
  if (type === "image/png") return hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47]);
  if (type === "image/jpeg") return hasBytes(bytes, [0xff, 0xd8, 0xff]);
  if (type === "image/gif") return new TextDecoder().decode(bytes.slice(0, 6)).startsWith("GIF8");
  if (type === "image/webp") {
    return (
      new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
    );
  }
  if (type === "image/avif") return new TextDecoder().decode(bytes.slice(4, 12)).includes("ftyp");
  if (type === "image/svg+xml") {
    return new TextDecoder().decode(bytes.slice(0, 1_024)).toLowerCase().includes("<svg");
  }
  return hasBytes(bytes, [0x00, 0x00, 0x01, 0x00]);
}

function hasBytes(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((byte, index) => bytes[index] === byte);
}

function isSafePublicUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username.length > 0 || url.password.length > 0) return false;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".test") ||
    hostname.endsWith(".example") ||
    hostname.endsWith(".invalid") ||
    hostname.startsWith("[")
  ) {
    return false;
  }
  const ipv4 = parseIpv4(hostname);
  return ipv4 === null || isPublicIpv4(ipv4);
}

function parseIpv4(hostname: string): readonly number[] | null {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return null;
  const parts = hostname.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

function isPublicIpv4(parts: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function fallbackFavicon(website: URL, result: string): Response {
  const letter = websiteNameFromUrl(website)
    .charAt(0)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "?");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#29251d"/><text x="16" y="21" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="16" font-weight="700" fill="#f59e0b">${letter}</text></svg>`;
  return new Response(svg, {
    headers: faviconHeaders("image/svg+xml", FALLBACK_CACHE_SECONDS, result),
  });
}

function faviconHeaders(contentType: string, maxAge: number, result: string): Headers {
  return new Headers({
    "cache-control": `public, max-age=${maxAge}`,
    "content-security-policy": "sandbox; default-src 'none'",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-favicon-result": result,
  });
}

function defaultCache(): Cache | null {
  return typeof caches === "undefined" ? null : caches.default;
}

async function readCachedFavicon(cache: Cache | null, key: Request): Promise<Response | undefined> {
  if (cache === null) return undefined;
  try {
    return await cache.match(key);
  } catch {
    return undefined;
  }
}
