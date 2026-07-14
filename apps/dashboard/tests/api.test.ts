// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ApiError,
  buildSessionHeadsUrl,
  buildSessionListUrl,
  buildStatsUrl,
  checkApiToken,
  clearApiToken,
  createProjectKey,
  fetchAccount,
  fetchAdminStats,
  fetchAdminUsers,
  fetchAuthConfig,
  fetchLiveSessions,
  fetchProjectStats,
  fetchSessionHeads,
  fetchSessionState,
  getApiToken,
  health,
  listSessions,
  revokeProjectKey,
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

  it("loads session heads with the current warehouse snapshot", async () => {
    setApiToken("secret-token");
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
    expect(readFetchHeaders().get("authorization")).toBe("Bearer secret-token");
  });

  it("loads one session state with encoded ids", async () => {
    setApiToken("secret-token");
    fetchMock.mockResolvedValue(jsonResponse({ session_id: "session/1" }));

    await fetchSessionState("project 1", "session/1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/projects/project%201/sessions/session%2F1/state",
      { headers: expect.any(Headers) },
    );
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

  it("loads hosted auth settings without leaking the saved local token", async () => {
    setApiToken("local-only-token");
    fetchMock.mockResolvedValue(jsonResponse({ mode: "github" }));

    await expect(fetchAuthConfig()).resolves.toEqual({ mode: "github" });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/config", {
      headers: expect.any(Headers),
    });
    expect(readFetchHeaders().get("authorization")).toBeNull();
  });

  it("uses the hosted session cookie without adding a bearer token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        user: { id: "u1", name: "Sunny", email: "sunny@example.com" },
        workspaces: [],
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
        jsonResponse({ key: { id: "key_one", name: "Production", active: false } }),
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

function readFetchHeaders(callIndex = 0): Headers {
  const init = fetchMock.mock.calls[callIndex]?.[1];
  const headers = init?.headers;
  expect(headers).toBeInstanceOf(Headers);
  if (!(headers instanceof Headers)) {
    throw new Error("Fetch headers were not set.");
  }
  return headers;
}
