import {
  liveTicketResponseSchema,
  segmentRefSchema,
  sessionManifestSchema,
} from "@orange-replay/shared/schemas";
import { MAX_ENCODED_SEGMENT_BYTES } from "@orange-replay/shared/constants";
import type { LiveTicketResponse, SegmentRef, SessionManifest } from "@orange-replay/shared/types";
import type {
  LiveRequest,
  LoadSessionOptions,
  PlayerApi,
  PlayerApiInput,
  SegmentRequest,
  SessionRequest,
  ReplayAssetMap,
  ReplayAssetMapEntry,
  ReplayAssetRequest,
} from "./types.ts";

export { MAX_ENCODED_SEGMENT_BYTES };

const MAX_REPLAY_ASSET_MAP_BYTES = 256 * 1024;

export async function loadSession(
  api: PlayerApiInput,
  options: LoadSessionOptions,
): Promise<SessionManifest> {
  const resolved = resolveApi(api);
  const response = await resolved.fetchFn(resolved.manifestUrl(options), {
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, "Could not load session manifest."));
  }

  return sessionManifestSchema.parse(await response.json());
}

export async function fetchSegmentBytes(
  api: PlayerApiInput,
  options: SessionRequest & { segment: SegmentRef; signal?: AbortSignal },
): Promise<Uint8Array> {
  const segment = segmentRefSchema.parse(options.segment);
  if (segment.bytes > MAX_ENCODED_SEGMENT_BYTES) {
    throw new Error("Replay segment is too large to load safely.");
  }

  const resolved = resolveApi(api);
  const segmentName = segmentFileName(segment);
  const request: SegmentRequest = { ...options, segment, segmentName };
  const response = await resolved.fetchFn(resolved.segmentUrl(request), {
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, "Could not load replay segment."));
  }

  const bytes = await readResponseBytesCapped(response, segment.bytes);
  if (bytes.byteLength !== segment.bytes) {
    throw new Error("Replay segment size does not match the session manifest.");
  }
  return bytes;
}

export async function readResponseBytesCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_ENCODED_SEGMENT_BYTES) {
    await response.body?.cancel();
    throw new Error("Replay segment byte limit is invalid.");
  }
  const cleanLimit = maxBytes;
  const declaredLength = readContentLength(response.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > cleanLimit) {
    await response.body?.cancel();
    throw new Error("Replay segment response exceeds its allowed size.");
  }

  const body = response.body;
  if (body === null) {
    throw new Error("Replay segment response body is missing.");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > cleanLimit) {
        await reader.cancel();
        throw new Error("Replay segment response exceeds its allowed size.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function liveSocketUrl(api: PlayerApiInput, options: LiveRequest): string {
  return resolveApi(api).liveUrl(options);
}

export async function mintLiveTicket(
  api: PlayerApiInput,
  options: SessionRequest & { signal?: AbortSignal },
): Promise<LiveTicketResponse> {
  const resolved = resolveApi(api);
  const response = await resolved.fetchFn(resolved.liveTicketUrl(options), {
    method: "POST",
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, "Could not create a live ticket."));
  }

  return liveTicketResponseSchema.parse(await response.json());
}

export async function loadReplayAssetMap(
  api: PlayerApiInput,
  options: SessionRequest & { signal?: AbortSignal },
): Promise<ReplayAssetMap | null> {
  const resolved = resolveApi(api);
  const url = resolved.assetMapUrl?.(options);
  if (url === undefined) return null;
  const response = await resolved.fetchFn(url, { signal: options.signal });
  if (response.status === 404 || response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error(await readApiError(response, "Could not load replay assets."));
  const bytes = await readResponseBytesCapped(response, MAX_REPLAY_ASSET_MAP_BYTES);
  return parseReplayAssetMap(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
}

export async function fetchReplayAssetBytes(
  api: PlayerApiInput,
  options: ReplayAssetRequest & { bytes: number; signal?: AbortSignal },
): Promise<Uint8Array> {
  const resolved = resolveApi(api);
  const url = resolved.assetUrl?.(options);
  if (url === undefined) throw new Error("Replay asset loading is not configured.");
  const response = await resolved.fetchFn(url, { signal: options.signal });
  if (!response.ok) throw new Error(await readApiError(response, "Could not load replay asset."));
  const bytes = await readResponseBytesCapped(response, options.bytes);
  if (bytes.byteLength !== options.bytes)
    throw new Error("Replay asset size does not match its map.");
  return bytes;
}

export function segmentFileName(segment: SegmentRef): string {
  return segment.key.split("/").at(-1) ?? segment.key;
}

interface ResolvedApi {
  fetchFn: typeof fetch;
  manifestUrl: (params: SessionRequest) => string;
  segmentUrl: (params: SegmentRequest) => string;
  liveUrl: (params: LiveRequest) => string;
  liveTicketUrl: (params: SessionRequest) => string;
  assetMapUrl?: (params: SessionRequest) => string;
  assetUrl?: (params: ReplayAssetRequest) => string;
}

function readContentLength(value: string | null): number | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function resolveApi(api: PlayerApiInput): ResolvedApi {
  const apiObject: PlayerApi = typeof api === "string" ? { baseUrl: api } : api;
  const baseUrl = stripTrailingSlash(apiObject.baseUrl ?? "");

  return {
    fetchFn: apiObject.fetch ?? fetch.bind(globalThis),
    manifestUrl:
      apiObject.manifestUrl ??
      ((params) =>
        `${baseUrl}/api/v1/projects/${encodePath(params.projectId)}/sessions/${encodePath(
          params.sessionId,
        )}/manifest`),
    segmentUrl:
      apiObject.segmentUrl ??
      ((params) =>
        `${baseUrl}/api/v1/projects/${encodePath(params.projectId)}/sessions/${encodePath(
          params.sessionId,
        )}/segments/${encodePath(params.segmentName)}`),
    liveUrl:
      apiObject.liveUrl ??
      ((params) =>
        webSocketUrl(
          `${baseUrl}/api/v1/projects/${encodePath(params.projectId)}/sessions/${encodePath(
            params.sessionId,
          )}/live?ticket=${encodeURIComponent(params.ticket)}`,
        )),
    liveTicketUrl:
      apiObject.liveTicketUrl ??
      ((params) =>
        `${baseUrl}/api/v1/projects/${encodePath(params.projectId)}/sessions/${encodePath(
          params.sessionId,
        )}/live-ticket`),
    assetMapUrl: apiObject.assetMapUrl,
    assetUrl: apiObject.assetUrl,
  };
}

function parseReplayAssetMap(value: unknown): ReplayAssetMap {
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["entries"])) {
    throw new Error("Replay asset map is invalid.");
  }
  if (value["entries"].length > 64) throw new Error("Replay asset map is too large.");
  return { version: 1, entries: value["entries"].map(parseReplayAssetMapEntry) };
}

function parseReplayAssetMapEntry(value: unknown): ReplayAssetMapEntry {
  if (!isRecord(value)) throw new Error("Replay asset entry is invalid.");
  const sourceUrl = value["sourceUrl"];
  const parentHash = value["parentHash"];
  const assetHash = value["assetHash"];
  const contentType = value["contentType"];
  const bytes = value["bytes"];
  const kind = value["kind"];
  if (
    typeof sourceUrl !== "string" ||
    sourceUrl.length === 0 ||
    sourceUrl.length > 2_048 ||
    typeof parentHash !== "string" ||
    (parentHash !== "" && !/^[a-f0-9]{64}$/.test(parentHash)) ||
    typeof assetHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(assetHash) ||
    typeof contentType !== "string" ||
    contentType.length === 0 ||
    contentType.length > 100 ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > 5 * 1024 * 1024 ||
    (kind !== "stylesheet" && kind !== "image" && kind !== "font")
  ) {
    throw new Error("Replay asset entry is invalid.");
  }
  if (!contentTypeMatchesAssetKind(contentType, kind)) {
    throw new Error("Replay asset entry is invalid.");
  }
  return { sourceUrl, parentHash, assetHash, contentType, bytes, kind };
}

function contentTypeMatchesAssetKind(
  contentType: string,
  kind: ReplayAssetMapEntry["kind"],
): boolean {
  if (kind === "stylesheet") return contentType === "text/css";
  if (kind === "image") return contentType.startsWith("image/");
  return contentType.startsWith("font/") || contentType === "application/font-woff";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
  } catch {
    /* use the fallback below */
  }

  return `${fallback} Status ${response.status}.`;
}

function webSocketUrl(path: string): string {
  const fallbackBase = "http://localhost";
  const base =
    typeof window === "undefined" || window.location === undefined
      ? fallbackBase
      : window.location.href;
  const url = new URL(path, base);

  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }

  return url.toString();
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
