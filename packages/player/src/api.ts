import { sessionManifestSchema } from "@orange-replay/shared/schemas";
import type { SegmentRef, SessionManifest } from "@orange-replay/shared/types";
import type {
  LiveRequest,
  LoadSessionOptions,
  PlayerApi,
  PlayerApiInput,
  SegmentRequest,
  SessionRequest,
} from "./types.ts";

export async function loadSession(
  api: PlayerApiInput,
  options: LoadSessionOptions,
): Promise<SessionManifest> {
  const resolved = resolveApi(api);
  const response = await resolved.fetchFn(resolved.manifestUrl(options), {
    headers: authHeaders(options.token),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, "Could not load session manifest."));
  }

  return sessionManifestSchema.parse(await response.json());
}

export async function fetchSegmentBytes(
  api: PlayerApiInput,
  options: SessionRequest & { segment: SegmentRef },
): Promise<Uint8Array> {
  const resolved = resolveApi(api);
  const segmentName = segmentFileName(options.segment);
  const request: SegmentRequest = { ...options, segmentName };
  const response = await resolved.fetchFn(resolved.segmentUrl(request), {
    headers: authHeaders(options.token),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, "Could not load replay segment."));
  }

  return new Uint8Array(await response.arrayBuffer());
}

export function liveSocketUrl(api: PlayerApiInput, options: LiveRequest): string {
  return resolveApi(api).liveUrl(options);
}

export function segmentFileName(segment: SegmentRef): string {
  return segment.key.split("/").at(-1) ?? segment.key;
}

interface ResolvedApi {
  fetchFn: typeof fetch;
  manifestUrl: (params: SessionRequest) => string;
  segmentUrl: (params: SegmentRequest) => string;
  liveUrl: (params: LiveRequest) => string;
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
          )}/live?token=${encodeURIComponent(params.token)}`,
        )),
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
