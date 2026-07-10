// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ApiError,
  buildSessionListUrl,
  buildStatsUrl,
  checkApiToken,
  clearApiToken,
  fetchLiveSessions,
  fetchProjectStats,
  getApiToken,
  health,
  listSessions,
  segmentUrl,
  setApiToken,
  setAuthRedirectHandler,
  type AuthRedirectEvent,
} from "../src/lib/api";
import { queryClient } from "../src/lib/query";
import { defaultProjectId } from "../src/lib/routes";

const fetchMock = vi.fn<typeof fetch>();
let restoreRedirectHandler: (() => void) | undefined;
let redirects: AuthRedirectEvent[] = [];

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
  queryClient.clear();
  redirects = [];
  restoreRedirectHandler = setAuthRedirectHandler((event) => {
    redirects.push(event);
  });
});

afterEach(() => {
  restoreRedirectHandler?.();
  restoreRedirectHandler = undefined;
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("api client", () => {
  it("stores and clears the dev token", () => {
    setApiToken("secret-token");
    expect(getApiToken()).toBe("secret-token");

    clearApiToken();
    expect(getApiToken()).toBeNull();
  });

  it("clears cached dashboard data when the token changes or clears", () => {
    queryClient.setQueryData(["sessions", "p1"], { private: true });

    setApiToken("secret-token");
    expect(queryClient.getQueryData(["sessions", "p1"])).toBeUndefined();

    queryClient.setQueryData(["sessions", "p1"], { private: true });
    clearApiToken();
    expect(queryClient.getQueryData(["sessions", "p1"])).toBeUndefined();
  });

  it("adds the bearer token to protected requests", async () => {
    setApiToken("secret-token");
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [], nextBefore: null }));

    await listSessions("p1");

    const headers = readFetchHeaders();
    expect(headers.get("authorization")).toBe("Bearer secret-token");
  });

  it("omits the bearer token on demo routes", async () => {
    window.history.replaceState({}, "", "/demo/sessions");
    setApiToken("secret-token");
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [], nextBefore: null }));

    await listSessions("demo-project");

    expect(readFetchHeaders().get("authorization")).toBeNull();
  });

  it("loads live sessions with bearer auth", async () => {
    setApiToken("secret-token");
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [] }));

    await fetchLiveSessions("project 1");

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/projects/project%201/live", {
      headers: expect.any(Headers),
    });
    const headers = readFetchHeaders();
    expect(headers.get("authorization")).toBe("Bearer secret-token");
  });

  it("loads project stats with the canonical shared filter", async () => {
    setApiToken("secret-token");
    fetchMock.mockResolvedValue(jsonResponse({ sessions: { value: 0, filter: {} } }));

    await fetchProjectStats("project 1", { browser: "Chrome", country: "US" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/projects/project%201/stats?country=US&browser=Chrome",
      { headers: expect.any(Headers) },
    );
  });

  it("does not add auth to health checks", async () => {
    setApiToken("secret-token");
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await health();

    const headers = readFetchHeaders();
    expect(headers.get("authorization")).toBeNull();
  });

  it("checks a typed token without saving it", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [], nextBefore: null }));

    await checkApiToken("typed-token");

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/projects/${defaultProjectId}/sessions?limit=1`,
      { headers: expect.any(Headers) },
    );
    const headers = readFetchHeaders();
    expect(headers.get("authorization")).toBe("Bearer typed-token");
    expect(getApiToken()).toBeNull();
  });

  it("checks a typed token against the requested project", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [], nextBefore: null }));

    await checkApiToken("typed-token", "project_two");

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/projects/project_two/sessions?limit=1", {
      headers: expect.any(Headers),
    });
  });

  it("builds the sessions query string", () => {
    expect(
      buildSessionListUrl("project 1", {
        before: "3000:session_a",
        country: "US",
        has_errors: true,
        has_rage: true,
        limit: 25,
        min_duration_ms: 60_000,
      }),
    ).toBe(
      "/api/v1/projects/project%201/sessions?limit=25&before=3000%3Asession_a&country=US&has_errors=1&has_rage=1&min_duration_ms=60000",
    );
  });

  it("builds a canonical stats query string", () => {
    expect(buildStatsUrl("project 1", { os: "macOS", device: "desktop", from: 1000 })).toBe(
      "/api/v1/projects/project%201/stats?from=1000&device=desktop&os=macOS",
    );
  });

  it("signals auth redirect on 401", async () => {
    setApiToken("bad-token");
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));

    await expect(listSessions("p1")).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    } satisfies Partial<ApiError>);
    expect(getApiToken()).toBeNull();
    expect(redirects).toEqual([{ status: 401, reason: "unauthorized" }]);
  });

  it("keeps demo 401 errors inline without redirecting", async () => {
    window.history.replaceState({}, "", "/demo/live");
    setApiToken("saved-private-token");
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));

    await expect(fetchLiveSessions("demo-project")).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    } satisfies Partial<ApiError>);
    expect(getApiToken()).toBe("saved-private-token");
    expect(redirects).toEqual([]);
  });

  it("does not redirect when a typed token is rejected", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));

    await expect(checkApiToken("bad-token")).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    } satisfies Partial<ApiError>);
    expect(redirects).toEqual([]);
  });

  it("signals auth redirect on 503", async () => {
    setApiToken("secret-token");
    fetchMock.mockResolvedValue(jsonResponse({ error: "auth_not_configured" }, 503));

    await expect(listSessions("p1")).rejects.toMatchObject({
      status: 503,
      code: "auth_not_configured",
    } satisfies Partial<ApiError>);
    expect(redirects).toEqual([{ status: 503, reason: "auth_unavailable" }]);
  });

  it("does not clear the token for non-auth 503 failures", async () => {
    setApiToken("secret-token");
    fetchMock.mockResolvedValue(jsonResponse({ error: "presence_unavailable" }, 503));

    await expect(fetchLiveSessions("p1")).rejects.toMatchObject({
      status: 503,
      code: "presence_unavailable",
    } satisfies Partial<ApiError>);
    expect(getApiToken()).toBe("secret-token");
    expect(redirects).toEqual([]);
  });

  it("builds segment URLs with encoded path parts", () => {
    expect(segmentUrl("project 1", "session/1", "seg-000001.ors")).toBe(
      "/api/v1/projects/project%201/sessions/session%2F1/segments/seg-000001.ors",
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readFetchHeaders(): Headers {
  const init = fetchMock.mock.calls[0]?.[1];
  const headers = init?.headers;
  expect(headers).toBeInstanceOf(Headers);
  if (!(headers instanceof Headers)) {
    throw new Error("Fetch headers were not set.");
  }
  return headers;
}
