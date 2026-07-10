import { sessionManifestSchema } from "@orange-replay/shared/schemas";
import { MAX_ENCODED_SEGMENT_BYTES } from "@orange-replay/shared/constants";
import type { LiveTicketResponse, SegmentRef, SessionManifest } from "@orange-replay/shared/types";
import type {
  LiveRequest,
  LoadSessionOptions,
  PlayerApi,
  PlayerApiInput,
  SegmentRequest,
  SessionRequest,
} from "./types.ts";

export { MAX_ENCODED_SEGMENT_BYTES };

export async function loadSession(
  api: PlayerApiInput,
  options: LoadSessionOptions,
): Promise<SessionManifest> {
  const resolved = resolveApi(api);
  const response = await resolved.fetchFn(resolved.manifestUrl(options), {
    headers: authHeaders(options.token),
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
  if (options.segment.bytes > MAX_ENCODED_SEGMENT_BYTES) {
    throw new Error("Replay segment is too large to load safely.");
  }

  const resolved = resolveApi(api);
  const segmentName = segmentFileName(options.segment);
  const request: SegmentRequest = { ...options, segmentName };
  const response = await resolved.fetchFn(resolved.segmentUrl(request), {
    headers: authHeaders(options.token),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, "Could not load replay segment."));
  }

  const bytes = await readResponseBytesCapped(response, options.segment.bytes);
  if (bytes.byteLength !== options.segment.bytes) {
    throw new Error("Replay segment size does not match the session manifest.");
  }
  return bytes;
}

export async function readResponseBytesCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const cleanLimit = Math.max(0, Math.min(MAX_ENCODED_SEGMENT_BYTES, Math.floor(maxBytes)));
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
  options: SessionRequest & { token: string; signal?: AbortSignal },
): Promise<LiveTicketResponse> {
  const resolved = resolveApi(api);
  const response = await resolved.fetchFn(resolved.liveTicketUrl(options), {
    method: "POST",
    headers: authHeaders(options.token),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, "Could not create a live ticket."));
  }

  return (await response.json()) as LiveTicketResponse;
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
  };
}

function authHeaders(token: string | undefined): Headers {
  const headers = new Headers();
  if (token !== undefined && token.length > 0) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return headers;
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
