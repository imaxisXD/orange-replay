import type { PlayerApi } from "@orange-replay/player";
import type { SessionManifest } from "@orange-replay/shared/types";

export function dashboardPlayerApi(manifest: SessionManifest, isDemo: boolean): PlayerApi {
  const manifestRequestPath = manifestPath(manifest.projectId, manifest.sessionId);

  return {
    fetch(input, init) {
      if (matchesPath(input, manifestRequestPath)) {
        return Promise.resolve(
          new Response(JSON.stringify(manifest), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      return fetch(input, isDemo ? withoutAuthorization(init) : init);
    },
  };
}

function withoutAuthorization(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  return { ...init, headers };
}

function manifestPath(projectId: string, sessionId: string): string {
  return `/api/v1/projects/${encodePathPart(projectId)}/sessions/${encodePathPart(
    sessionId,
  )}/manifest`;
}

function matchesPath(input: Parameters<typeof fetch>[0], path: string): boolean {
  try {
    const url = new URL(requestUrl(input), window.location.href);
    return url.pathname === path && url.search.length === 0;
  } catch {
    return false;
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

export function clampTime(value: number, durationMs: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(0, value), Math.max(0, durationMs));
}

export function readReplayOverlayColors() {
  return {
    cursorColor: readThemeColor("--amber", "oklch(0.784 0.159 72.991)"),
    clickColor: readThemeColor("--amber", "oklch(0.784 0.159 72.991)"),
    rageColor: readThemeColor("--danger", "oklch(0.662 0.198 25.892)"),
  };
}

function readThemeColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

export function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "The API request failed.";
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}
