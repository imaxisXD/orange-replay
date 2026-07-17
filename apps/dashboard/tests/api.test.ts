// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ApiError,
  buildSessionHeadsUrl,
  buildSessionListUrl,
  buildStatsUrl,
  createProjectKey,
  fetchAccount,
  fetchAdminStats,
  fetchAdminUsers,
  fetchAuthConfig,
  fetchLiveSessions,
  fetchProjectKeys,
  fetchProjectStats,
  fetchSessionHeads,
  fetchSessionState,
  health,
  listSessions,
  revokeProjectKey,
  segmentUrl,
} from "../src/lib/api";
import {
  clearDashboardAccess,
  setAuthRedirectHandler,
  type AuthRedirectEvent,
} from "../src/lib/dashboard-access";
import { queryClient } from "../src/lib/query";

const fetchMock = vi.fn<typeof fetch>();
let restoreRedirectHandler: (() => void) | undefined;
let redirects: AuthRedirectEvent[] = [];

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState({}, "", "/");
  clearDashboardAccess();
  queryClient.clear();
  redirects = [];
  restoreRedirectHandler = setAuthRedirectHandler((event) => {
    redirects.push(event);
  });
});

afterEach(() => {
  restoreRedirectHandler?.();
  restoreRedirectHandler = undefined;
  clearDashboardAccess();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("api client", () => {
  it("does not keep dashboard credentials in browser storage", () => {
    expect(window.localStorage.length).toBe(0);
  });

  it("clears cached dashboard data when access resets", () => {
    queryClient.setQueryData(["sessions", "p1"], { private: true });

    clearDashboardAccess();
    expect(queryClient.getQueryData(["sessions", "p1"])).toBeUndefined();
  });

  it("uses the Better Auth cookie without adding an authorization header", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [], nextBefore: null }));

    await listSessions("p1");

    const headers = readFetchHeaders();
    expect(headers.get("authorization")).toBeNull();
  });

  it("keeps demo requests anonymous", async () => {
    window.history.replaceState({}, "", "/demo/sessions");
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [], nextBefore: null }));

    await listSessions("demo-project");

    expect(readFetchHeaders().get("authorization")).toBeNull();
  });

  it("loads live sessions with cookie auth", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [] }));

    await fetchLiveSessions("project 1");

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/projects/project%201/live", {
      headers: expect.any(Headers),
    });
    const headers = readFetchHeaders();
    expect(headers.get("authorization")).toBeNull();
  });

  it("loads session heads with the current warehouse snapshot", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [] }));

    await fetchSessionHeads("project 1", {
      country: "US",
      limit: 100,
      opened_at: 10_000,
      sort: "duration",
      tracked_session_id: ["session_a"],
      warehouse_to: 9_000,
      warehouse_version: 42,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/projects/project%201/session-heads?limit=100&sort=duration&opened_at=10000&warehouse_to=9000&tracked_session_id=session_a&country=US&warehouse_version=42",
      { headers: expect.any(Headers) },
    );
    expect(readFetchHeaders().get("authorization")).toBeNull();
  });

  it("loads one session state with encoded ids", async () => {
    fetchMock.mockResolvedValue(jsonResponse(validSessionHead({ session_id: "session/1" })));

    await fetchSessionState("project 1", "session/1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/projects/project%201/sessions/session%2F1/state",
      { headers: expect.any(Headers) },
    );
  });

  it("loads project stats with the canonical shared filter", async () => {
    fetchMock.mockResolvedValue(jsonResponse(validProjectStatsResponse()));

    await fetchProjectStats("project 1", { browser: "Chrome", country: "US" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/projects/project%201/stats?country=US&browser=Chrome",
      { headers: expect.any(Headers) },
    );
  });

  it("does not add auth to health checks", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await health();

    const headers = readFetchHeaders();
    expect(headers.get("authorization")).toBeNull();
  });

  it("loads Better Auth settings without an authorization header", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ mode: "github" }));

    await expect(fetchAuthConfig()).resolves.toEqual({ mode: "github" });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/config", {
      headers: expect.any(Headers),
    });
    expect(readFetchHeaders().get("authorization")).toBeNull();
  });

  it("uses the hosted session cookie without adding an authorization header", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        user: {
          id: "u1",
          name: "Sunny",
          email: "sunny@example.com",
          emailVerified: true,
          image: null,
          role: "user",
        },
        workspaces: [],
        activeWorkspaceId: null,
        isAdmin: false,
      }),
    );

    await fetchAccount();

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/account", {
      headers: expect.any(Headers),
    });
    expect(readFetchHeaders().get("authorization")).toBeNull();
  });

  it("creates and revokes a named write key without storing its secret", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          key: {
            id: "key_one",
            name: "Production",
            active: true,
            createdAt: 1,
            createdBy: "u1",
            revokedAt: null,
            revokedBy: null,
            keyHashPrefix: "abc123",
          },
          secret: "or_live_secret",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          key: validProjectKey({
            active: false,
            revokedAt: 2,
            revokedBy: "u1",
          }),
        }),
      );

    await createProjectKey("project one", "Production");
    await revokeProjectKey("project one", "key/one");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/projects/project%20one/keys", {
      headers: expect.any(Headers),
      method: "POST",
      body: JSON.stringify({ name: "Production" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/projects/project%20one/keys/key%2Fone", {
      headers: expect.any(Headers),
      method: "DELETE",
    });
    expect(readFetchHeaders(0).get("authorization")).toBeNull();
    expect(readFetchHeaders(1).get("authorization")).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it("loads operator totals and an encoded user page", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ users: 1, newUsers: 1 }))
      .mockResolvedValueOnce(jsonResponse({ users: [], total: 0, limit: 25, offset: 25 }));

    await fetchAdminStats();
    await fetchAdminUsers({ limit: 25, offset: 25, search: "Sunny + team" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/admin/stats", {
      headers: expect.any(Headers),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/admin/users?limit=25&offset=25&search=Sunny+%2B+team",
      { headers: expect.any(Headers) },
    );
  });

  it("reports a clear invalid response when account data is incomplete", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ user: { id: "u1" }, workspaces: [], activeWorkspaceId: null, isAdmin: false }),
    );

    await expect(fetchAccount()).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
      message: "The server returned data in an unexpected format.",
    } satisfies Partial<ApiError>);
  });

  it("reports a clear invalid response when project key data is incomplete", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ keys: [{ id: "key_one" }] }));

    await expect(fetchProjectKeys("project one")).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
      message: "The server returned data in an unexpected format.",
    } satisfies Partial<ApiError>);
  });

  it("reports a clear invalid response when stats data is incomplete", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessions: { value: 0, filter: {} } }));

    await expect(fetchProjectStats("project one", {})).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
      message: "The server returned data in an unexpected format.",
    } satisfies Partial<ApiError>);
  });

  it("reports a clear invalid response when session data is incomplete", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ session_id: "session_one" }));

    await expect(fetchSessionState("project one", "session_one")).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
      message: "The server returned data in an unexpected format.",
    } satisfies Partial<ApiError>);
  });

  it("builds the sessions query string", () => {
    expect(
      buildSessionListUrl("project 1", {
        before: "friction:1102:session_a",
        country: "US",
        has_errors: true,
        has_rage: true,
        limit: 25,
        min_duration_ms: 60_000,
        sort: "friction",
      }),
    ).toBe(
      "/api/v1/projects/project%201/sessions?limit=25&before=friction%3A1102%3Asession_a&sort=friction&country=US&has_errors=1&has_rage=1&min_duration_ms=60000",
    );
  });

  it("builds the session-head query without a warehouse cursor", () => {
    expect(
      buildSessionHeadsUrl("project 1", {
        browser: "Chrome",
        limit: 25,
        opened_at: 10_000,
        sort: "clicks",
      }),
    ).toBe(
      "/api/v1/projects/project%201/session-heads?limit=25&sort=clicks&opened_at=10000&browser=Chrome",
    );
  });

  it("builds a canonical stats query string", () => {
    expect(buildStatsUrl("project 1", { os: "macOS", device: "desktop", from: 1000 })).toBe(
      "/api/v1/projects/project%201/stats?from=1000&device=desktop&os=macOS",
    );
  });

  it("signals auth redirect on 401", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));

    await expect(listSessions("p1")).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    } satisfies Partial<ApiError>);
    expect(redirects).toEqual([{ status: 401, reason: "unauthorized" }]);
  });

  it("keeps demo 401 errors inline without redirecting", async () => {
    window.history.replaceState({}, "", "/demo/live");
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));

    await expect(fetchLiveSessions("demo-project")).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    } satisfies Partial<ApiError>);
    expect(redirects).toEqual([]);
  });

  it("signals auth redirect on 503", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "auth_not_configured" }, 503));

    await expect(listSessions("p1")).rejects.toMatchObject({
      status: 503,
      code: "auth_not_configured",
    } satisfies Partial<ApiError>);
    expect(redirects).toEqual([{ status: 503, reason: "auth_unavailable" }]);
  });

  it("does not redirect for non-auth 503 failures", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "presence_unavailable" }, 503));

    await expect(fetchLiveSessions("p1")).rejects.toMatchObject({
      status: 503,
      code: "presence_unavailable",
    } satisfies Partial<ApiError>);
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

function readFetchHeaders(callIndex = 0): Headers {
  const init = fetchMock.mock.calls[callIndex]?.[1];
  const headers = init?.headers;
  expect(headers).toBeInstanceOf(Headers);
  if (!(headers instanceof Headers)) {
    throw new Error("Fetch headers were not set.");
  }
  return headers;
}

function validProjectKey(
  overrides: Partial<{
    active: boolean;
    revokedAt: number | null;
    revokedBy: string | null;
  }> = {},
): {
  id: string;
  name: string;
  keyHashPrefix: string;
  active: boolean;
  createdAt: number;
  createdBy: string;
  revokedAt: number | null;
  revokedBy: string | null;
} {
  return {
    id: "key_one",
    name: "Production",
    keyHashPrefix: "abc123",
    active: true,
    createdAt: 1,
    createdBy: "u1",
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

function validSessionHead(
  overrides: Partial<{ session_id: string }> = {},
): Record<string, unknown> {
  return {
    session_id: "session_one",
    project_id: "project_one",
    org_id: "workspace_one",
    started_at: 1,
    ended_at: 2,
    duration_ms: 1,
    country: null,
    region: null,
    city: null,
    device: null,
    browser: null,
    os: null,
    entry_url: null,
    url_count: 1,
    page_count: 1,
    analytics_version: 2,
    max_scroll_depth: 50,
    quick_backs: 0,
    interaction_time_ms: 1,
    activity_hist: null,
    clicks: 1,
    errors: 0,
    rages: 0,
    navs: 0,
    bytes: 1,
    segment_count: 1,
    flags: 0,
    manifest_key: "p/project_one/session_one/manifest.json",
    expires_at: 10,
    activity: "complete",
    details_state: "exact",
    replay_source: "recorded",
    ...overrides,
  };
}

function validProjectStatsResponse(): Record<string, unknown> {
  const allSessions = { value: 0, filter: {} };
  const pageSessions = { value: 0, filter: { has_page_coverage: true } };
  const insightSessions = { value: 0, filter: { has_insights: true } };

  return {
    filter: {},
    sessions: allSessions,
    duration: { average: allSessions, p50: allSessions },
    clicks: allSessions,
    pagesPerSession: {
      value: null,
      filter: { has_page_coverage: true },
      includedSessions: pageSessions,
      totalSessions: allSessions,
    },
    insights: {
      ragePercent: { value: null, filter: { has_rage: true } },
      quickBackPercent: { value: null, filter: { has_quick_back: true } },
      averageInteractionTimeMs: { value: null, filter: { has_insights: true } },
      averageMaxScrollDepth: { value: null, filter: { has_insights: true } },
      includedSessions: insightSessions,
      totalSessions: allSessions,
    },
    breakdowns: {
      country: [],
      region: [],
      city: [],
      device: [],
      browser: [],
      os: [],
      entryPage: [],
    },
    errors: [],
    liveNow: allSessions,
  };
}
