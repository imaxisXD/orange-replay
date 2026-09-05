const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_CSS_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_DNS_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const ASSET_FETCH_USER_AGENT = "Orange-Replay-Assets/1.0 (+https://orangereplay.app)";
const PRIVATE_QUERY_NAMES = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "credential",
  "jwt",
  "key",
  "password",
  "passwd",
  "session",
  "sessionid",
  "sig",
  "signature",
  "token",
  "x-amz-credential",
  "x-amz-signature",
  "x-goog-credential",
  "x-goog-signature",
]);

export type ReplayAssetKind = "stylesheet" | "image" | "font";

export interface FetchedReplayAsset {
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
  kind: ReplayAssetKind;
}

export interface PublicAssetFetchOptions {
  baseUrl?: string;
  blockedHosts?: readonly string[];
  fetchFn?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
  timeoutMs?: number;
}

export async function fetchPublicReplayAsset(
  sourceUrl: string,
  options: PublicAssetFetchOptions = {},
): Promise<FetchedReplayAsset | null> {
  let url = safePublicAssetUrl(sourceUrl, options.baseUrl, options.blockedHosts);
  if (url === null) return null;

  const fetchFn = options.fetchFn ?? fetch.bind(globalThis);
  const controller = new AbortController();
  const signal = controller.signal;
  // One deadline covers DNS, every redirect, and the complete response body.
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Replay asset download timed out.", "AbortError")),
    options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );
  const timedFetch: typeof fetch = (input, init) => {
    signal.throwIfAborted();
    return waitForAssetWork(
      fetchFn(input, { ...init, signal }).then((response) => {
        if (signal.aborted) {
          void response.body?.cancel(signal.reason).catch(() => undefined);
          signal.throwIfAborted();
        }
        return response;
      }),
      signal,
    );
  };
  const resolveHost =
    options.resolveHost ?? ((hostname) => resolvePublicHost(hostname, timedFetch, signal));

  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (!(await waitForAssetWork(hostnameResolvesPublicly(url.hostname, resolveHost), signal)))
        return null;

      const response = await timedFetch(url, {
        method: "GET",
        headers: {
          accept:
            "text/css,image/avif,image/webp,image/png,image/jpeg,image/gif,font/woff2,font/woff,*/*;q=0.1",
          "user-agent": ASSET_FETCH_USER_AGENT,
        },
        cache: "no-store",
        redirect: "manual",
      });

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        await cancelResponseBody(response, signal);
        if (location === null || redirects === MAX_REDIRECTS) return null;
        url = safePublicAssetUrl(location, url.toString(), options.blockedHosts);
        if (url === null) return null;
        continue;
      }

      if (!response.ok) {
        await cancelResponseBody(response, signal);
        return null;
      }

      const contentType = cleanContentType(response.headers.get("content-type"));
      const kind = assetKindForContentType(contentType);
      if (kind === null) {
        await cancelResponseBody(response, signal);
        return null;
      }
      const byteLimit = kind === "stylesheet" ? MAX_CSS_BYTES : MAX_ASSET_BYTES;
      const bytes = await readBodyCapped(response, byteLimit, signal);
      if (!assetBytesMatchType(bytes, contentType, kind)) return null;
      return { bytes, contentType, finalUrl: url.toString(), kind };
    }

    return null;
  } finally {
    clearTimeout(timeout);
    // A failed DNS lookup may still have another address lookup in flight.
    controller.abort();
  }
}

export function safePublicAssetUrl(
  sourceUrl: string,
  baseUrl?: string,
  blockedHosts: readonly string[] = [],
): URL | null {
  if (sourceUrl.length === 0 || sourceUrl.length > 2_048) return null;
  let url: URL;
  try {
    url = new URL(sourceUrl, baseUrl);
  } catch {
    return null;
  }

  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    return null;
  }
  if (url.port !== "" && url.port !== "80" && url.port !== "443") return null;
  if (hasPrivateQuery(url)) return null;
  const hostname = normalizedHostname(url.hostname);
  if (hostname.length === 0 || hostname.includes(":") || isBlockedHostname(hostname)) return null;
  if (isIpv4Address(hostname) && !isPublicIpv4(hostname)) return null;
  for (const blocked of blockedHosts) {
    const cleanBlocked = normalizedHostname(blocked);
    if (hostname === cleanBlocked || hostname.endsWith(`.${cleanBlocked}`)) return null;
  }
  url.hash = "";
  return url;
}

async function waitForAssetWork<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let stopWaiting = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    stopWaiting = () => reject(signal.reason);
    signal.addEventListener("abort", stopWaiting, { once: true });
    if (signal.aborted) stopWaiting();
  });
  try {
    const result = await Promise.race([work, aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", stopWaiting);
  }
}

async function cancelResponseBody(response: Response, signal: AbortSignal): Promise<void> {
  if (response.body !== null) await waitForAssetWork(response.body.cancel(), signal);
}

function hasPrivateQuery(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (PRIVATE_QUERY_NAMES.has(name.toLowerCase())) return true;
  }
  return false;
}

export async function hostnameResolvesPublicly(
  hostname: string,
  resolveHost: (hostname: string) => Promise<readonly string[]>,
): Promise<boolean> {
  if (isIpv4Address(hostname)) return isPublicIpv4(hostname);
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every(isPublicIpAddress);
}

async function resolvePublicHost(
  hostname: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<string[]> {
  const results = await Promise.all(
    (["A", "AAAA"] as const).map((type) => resolveDnsType(hostname, type, fetchFn, signal)),
  );
  return [...new Set(results.flat())];
}

async function resolveDnsType(
  hostname: string,
  type: "A" | "AAAA",
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<string[]> {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", type);
  const response = await fetchFn(url, {
    headers: { accept: "application/dns-json" },
    cache: "no-store",
  });
  if (!response.ok) {
    await cancelResponseBody(response, signal);
    throw new Error("Public DNS validation failed.");
  }
  const bytes = await readBodyCapped(response, MAX_DNS_RESPONSE_BYTES, signal);
  const value = JSON.parse(new TextDecoder().decode(bytes)) as { Answer?: unknown };
  if (!Array.isArray(value.Answer)) return [];
  return value.Answer.flatMap((answer) => {
    if (answer === null || typeof answer !== "object") return [];
    const data = (answer as { data?: unknown }).data;
    return typeof data === "string" && (isIpv4Address(data) || data.includes(":")) ? [data] : [];
  });
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponseBody(response, signal);
    throw assetRejectedError("Replay asset response is too large.");
  }
  if (response.body === null) throw assetRejectedError("Replay asset response body is missing.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let pendingRead: ReturnType<typeof reader.read> | undefined;
  try {
    for (;;) {
      pendingRead = reader.read();
      const next = await waitForAssetWork(pendingRead, signal);
      pendingRead = undefined;
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        throw assetRejectedError("Replay asset response is too large.");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    // Cancellation closes pending reads immediately. Its underlying cleanup
    // must not extend the download deadline or hide the original failure.
    void reader.cancel(error).catch(() => undefined);
    await pendingRead?.catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function assetRejectedError(message: string): Error {
  const error = new Error(message);
  error.name = "ReplayAssetRejectedError";
  return error;
}

function cleanContentType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function assetKindForContentType(contentType: string): ReplayAssetKind | null {
  if (contentType === "text/css") return "stylesheet";
  if (
    contentType === "image/png" ||
    contentType === "image/jpeg" ||
    contentType === "image/gif" ||
    contentType === "image/webp" ||
    contentType === "image/avif"
  ) {
    return "image";
  }
  if (
    contentType === "font/woff" ||
    contentType === "font/woff2" ||
    contentType === "font/ttf" ||
    contentType === "font/otf" ||
    contentType === "application/font-woff"
  ) {
    return "font";
  }
  return null;
}

function assetBytesMatchType(
  bytes: Uint8Array,
  contentType: string,
  kind: ReplayAssetKind,
): boolean {
  if (bytes.byteLength === 0) return false;
  if (kind === "stylesheet") {
    try {
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      return true;
    } catch {
      return false;
    }
  }
  if (contentType === "image/png") return hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47]);
  if (contentType === "image/jpeg") return hasBytes(bytes, [0xff, 0xd8, 0xff]);
  if (contentType === "image/gif") return textPrefix(bytes, 6).startsWith("GIF8");
  if (contentType === "image/webp") {
    return textPrefix(bytes, 4) === "RIFF" && textRange(bytes, 8, 12) === "WEBP";
  }
  if (contentType === "image/avif") return textRange(bytes, 4, 12).includes("ftyp");
  if (contentType.includes("woff2")) return textPrefix(bytes, 4) === "wOF2";
  if (contentType.includes("woff")) return textPrefix(bytes, 4) === "wOFF";
  if (contentType.includes("ttf")) return hasBytes(bytes, [0x00, 0x01, 0x00, 0x00]);
  if (contentType.includes("otf")) return textPrefix(bytes, 4) === "OTTO";
  return bytes.byteLength >= 4;
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".test") ||
    hostname.endsWith(".example") ||
    hostname.endsWith(".invalid") ||
    hostname.endsWith(".workers.dev")
  );
}

function isPublicIpAddress(value: string): boolean {
  return value.includes(":") ? isPublicIpv6(value) : isPublicIpv4(value);
}

function isIpv4Address(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isPublicIpv4(value: string): boolean {
  if (!isIpv4Address(value)) return false;
  const [a = 0, b = 0, c = 0] = value.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPublicIpv6(value: string): boolean {
  const clean = value.toLowerCase().split("%", 1)[0] ?? "";
  if (clean === "::" || clean === "::1") return false;
  if (clean.startsWith("fc") || clean.startsWith("fd") || /^fe[89ab]/.test(clean)) return false;
  const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(clean)?.[1];
  return mapped === undefined ? /^[0-9a-f:]+$/.test(clean) : isPublicIpv4(mapped);
}

function normalizedHostname(value: string): string {
  return value.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function hasBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function textPrefix(bytes: Uint8Array, length: number): string {
  return textRange(bytes, 0, length);
}

function textRange(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder().decode(bytes.slice(start, end));
}
