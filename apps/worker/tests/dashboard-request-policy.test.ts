import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ApiAuthContext } from "../src/api/auth.ts";
import {
  matchDashboardRequest,
  projectRouteAccess,
  type DashboardProjectRouteName,
} from "../src/api/dashboard-request-policy.ts";
import type { Env } from "../src/env.ts";
import { handleApi } from "../src/api/handler.ts";

const mocks = vi.hoisted(() => ({
  checkAuth: vi.fn(),
  demoRateLimitAllows: vi.fn(),
  projectAuthError: vi.fn(),
  isTrustedMutationOrigin: vi.fn(),
  checkAnalyticsReadRateLimit: vi.fn(),
  publicPageRateLimitAllows: vi.fn(),
  getPublicPageDataResponse: vi.fn(),
  getPublicManifest: vi.fn(),
  getPublicSegment: vi.fn(),
  proxyLiveSession: vi.fn(),
  mintLiveTicket: vi.fn(),
  getDemoDiscovery: vi.fn(),
  getInstallStatus: vi.fn(),
  getProjectConfig: vi.fn(),
  getProjectKeys: vi.fn(),
  getProjectStats: vi.fn(),
  listLiveSessions: vi.fn(),
  putProjectConfig: vi.fn(),
  getManifest: vi.fn(),
  getSegment: vi.fn(),
  listSessions: vi.fn(),
  getSessionState: vi.fn(),
  listSessionHeads: vi.fn(),
}));

vi.mock("../src/api/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/auth.ts")>();
  return {
    ...actual,
    checkAuth: mocks.checkAuth,
    demoRateLimitAllows: mocks.demoRateLimitAllows,
    projectAuthError: mocks.projectAuthError,
  };
});

vi.mock("../src/auth/config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/config.ts")>();
  return { ...actual, isTrustedMutationOrigin: mocks.isTrustedMutationOrigin };
});

vi.mock("../src/analytics/read-rate-limit.ts", () => ({
  checkAnalyticsReadRateLimit: mocks.checkAnalyticsReadRateLimit,
}));

vi.mock("../src/public-page/data.ts", () => ({
  getPublicPageDataResponse: mocks.getPublicPageDataResponse,
  getPublicManifest: mocks.getPublicManifest,
  getPublicSegment: mocks.getPublicSegment,
  publicPageRateLimitAllows: mocks.publicPageRateLimitAllows,
}));

vi.mock("../src/api/live-ticket.ts", () => ({
  mintLiveTicket: mocks.mintLiveTicket,
  proxyLiveSession: mocks.proxyLiveSession,
}));

vi.mock("../src/api/project-routes.ts", () => ({
  getDemoDiscovery: mocks.getDemoDiscovery,
  getInstallStatus: mocks.getInstallStatus,
  getProjectConfig: mocks.getProjectConfig,
  getProjectKeys: mocks.getProjectKeys,
  getProjectStats: mocks.getProjectStats,
  listLiveSessions: mocks.listLiveSessions,
  putProjectConfig: mocks.putProjectConfig,
}));

vi.mock("../src/api/session-routes.ts", () => ({
  getManifest: mocks.getManifest,
  getSegment: mocks.getSegment,
  listSessions: mocks.listSessions,
}));

vi.mock("../src/api/session-head-routes.ts", () => ({
  getSessionState: mocks.getSessionState,
  listSessionHeads: mocks.listSessionHeads,
}));

const executionContext = {} as Parameters<typeof handleApi>[2];
const testEnv = { WORKER_ENV: "test", DEV_TEST_ROUTES: "1" } as Env;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  mocks.checkAuth.mockResolvedValue(sessionAuth());
  mocks.demoRateLimitAllows.mockResolvedValue(true);
  mocks.projectAuthError.mockReturnValue(null);
  mocks.isTrustedMutationOrigin.mockReturnValue(true);
  mocks.checkAnalyticsReadRateLimit.mockResolvedValue({ allowed: true });
  mocks.publicPageRateLimitAllows.mockResolvedValue(true);
  mocks.getPublicPageDataResponse.mockImplementation(async () => jsonResponse({ ok: true }));
  mocks.getPublicManifest.mockImplementation(async () => jsonResponse({ ok: true }));
  mocks.getPublicSegment.mockImplementation(async () => new Response("segment"));
  mocks.proxyLiveSession.mockImplementation(async () => new Response("live"));
  mocks.mintLiveTicket.mockImplementation(async () => jsonResponse({ ticket: "ticket_1" }));
  mocks.getDemoDiscovery.mockImplementation(async () => jsonResponse({ projectId: "demo" }));
  mocks.getInstallStatus.mockImplementation(async () => jsonResponse({ firstEventAt: null }));
  mocks.getProjectConfig.mockImplementation(async () => jsonResponse({ sampleRate: 1 }));
  mocks.getProjectKeys.mockImplementation(async () => jsonResponse({ keys: [] }));
  mocks.getProjectStats.mockImplementation(async () => jsonResponse({ sessions: { value: 0 } }));
  mocks.listLiveSessions.mockImplementation(async () => jsonResponse({ sessions: [] }));
  mocks.putProjectConfig.mockImplementation(async () => jsonResponse({ sampleRate: 1 }));
  mocks.getManifest.mockImplementation(async () =>
    jsonResponse({ error: "not_found" }, 404, {
      "cache-control": "public, max-age=300, must-revalidate",
    }),
  );
  mocks.getSegment.mockImplementation(async () => new Response("segment"));
  mocks.listSessions.mockImplementation(async () => jsonResponse({ sessions: [] }));
  mocks.getSessionState.mockImplementation(async () => jsonResponse({ session_id: "session_1" }));
  mocks.listSessionHeads.mockImplementation(async () => jsonResponse({ sessions: [] }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dashboard request policy", () => {
  it("owns every supported path, method, access rule, rate limit, origin, and response wrapper", () => {
    const cases = [
      route("GET", "/api/v1/health", "health", "health", "public"),
      route("DELETE", "/api/auth/session", "better_auth", "better_auth", "better_auth", {
        responsePolicy: "security_headers",
      }),
      route("GET", "/api/v1/auth/config", "auth_config", "auth_config", "public"),
      route("GET", "/api/v1/demo", "demo_discovery", "demo_discovery", "public"),
      route(
        "GET",
        "/api/v1/public-pages/public_1",
        "public_page_data",
        "public_page_data",
        "public",
        { handlerRateLimit: "public_page", publicId: "public_1" },
      ),
      route(
        "GET",
        "/api/v1/public-pages/public_1/replays/replay_1/manifest",
        "public_manifest",
        "public_manifest",
        "public",
        {
          handlerRateLimit: "public_page",
          publicId: "public_1",
          publicReplayId: "replay_1",
        },
      ),
      route(
        "GET",
        "/api/v1/public-pages/public_1/replays/replay_1/segments/seg-000001.ors",
        "public_segment",
        "public_segment",
        "public",
        {
          handlerRateLimit: "public_page",
          publicId: "public_1",
          publicReplayId: "replay_1",
          segmentName: "seg-000001.ors",
        },
      ),
      route("GET", "/api/v1/projects/project_1/sessions/session_1/live", "live", "live", "ticket", {
        projectId: "project_1",
        sessionId: "session_1",
      }),
      route("GET", "/api/v1/account", "account", "account", "dashboard", {
        access: "session",
      }),
      route(
        "POST",
        "/api/v1/account/bootstrap",
        "account_bootstrap",
        "account_bootstrap",
        "dashboard",
        { access: "session", requiresTrustedMutationOrigin: true },
      ),
      route("GET", "/api/v1/admin/stats", "admin_stats", "admin_stats", "dashboard", {
        access: "global_admin",
      }),
      route("GET", "/api/v1/admin/users", "admin_users", "admin_users", "dashboard", {
        access: "global_admin",
      }),
      projectRoute("GET", "/sessions", "sessions_list", "sessions_list", "sessions_list", {
        handlerRateLimit: "analytics_read",
      }),
      projectRoute("GET", "/session-heads", "session_heads", "session_heads", "session_heads"),
      projectRoute("GET", "/stats", "project_stats", "project_stats", "project_stats", {
        handlerRateLimit: "analytics_read",
      }),
      projectRoute("GET", "/live", "project_live", "project_live", "project_live"),
      projectRoute(
        "GET",
        "/config",
        "project_config_read",
        "project_config",
        "project_config_read",
      ),
      projectRoute(
        "PUT",
        "/config",
        "project_config_write",
        "project_config",
        "project_config_write",
        { requiresTrustedMutationOrigin: true },
      ),
      projectRoute("GET", "/install-status", "install_status", "install_status", "install_status"),
      projectRoute(
        "GET",
        "/public-page",
        "public_page_read",
        "public_page_settings",
        "public_page_read",
      ),
      projectRoute(
        "PUT",
        "/public-page",
        "public_page_write",
        "public_page_settings",
        "public_page_write",
        { requiresTrustedMutationOrigin: true },
      ),
      projectRoute("GET", "/keys", "project_keys_read", "project_keys", "project_keys", {
        requiresSessionAuth: true,
      }),
      projectRoute("POST", "/keys", "project_keys_create", "project_keys", "project_keys", {
        requiresSessionAuth: true,
        requiresTrustedMutationOrigin: true,
      }),
      projectRoute("DELETE", "/keys/key_1", "project_key_revoke", "project_key", "project_keys", {
        keyId: "key_1",
        requiresSessionAuth: true,
        requiresTrustedMutationOrigin: true,
      }),
      projectRoute("GET", "/sessions/session_1/manifest", "manifest", "manifest", "manifest", {
        sessionId: "session_1",
      }),
      projectRoute(
        "GET",
        "/sessions/session_1/state",
        "session_state",
        "session_state",
        "session_state",
        { sessionId: "session_1" },
      ),
      projectRoute(
        "POST",
        "/sessions/session_1/live-ticket",
        "live_ticket",
        "live_ticket",
        "live_ticket",
        { sessionId: "session_1", requiresTrustedMutationOrigin: true },
      ),
      projectRoute(
        "GET",
        "/sessions/session_1/segments/seg-000001.ors",
        "segment",
        "segment",
        "segment",
        { sessionId: "session_1", segmentName: "seg-000001.ors" },
      ),
    ] as const;

    for (const testCase of cases) {
      const policy = matchDashboardRequest(testCase.method, testCase.pathname);
      expect(policy, `${testCase.method} ${testCase.pathname}`).toEqual({
        action: testCase.action,
        routeName: testCase.routeName,
        methodAllowed: true,
        authentication: testCase.authentication,
        access: testCase.authentication === "dashboard" ? "authenticated" : "none",
        projectIdForAuth: /^\/api\/v1\/projects\/([^/]+)/.exec(testCase.pathname)?.[1] ?? null,
        projectRoute: null,
        projectId: null,
        projectIdValid: true,
        sessionId: null,
        sessionIdValid: true,
        keyId: null,
        keyIdValid: true,
        publicId: null,
        publicIdValid: true,
        publicReplayId: null,
        publicReplayIdValid: true,
        segmentName: null,
        segmentNameValid: true,
        requiresSessionAuth: false,
        requiresTrustedMutationOrigin: false,
        demoRateLimit: testCase.authentication === "dashboard",
        handlerRateLimit: "none",
        responsePolicy: "none",
        ...testCase.expected,
      });
    }
  });

  it("keeps log names independent from method handling and preserves the config exception", () => {
    const ordinaryMismatches = [
      ["HEAD", "/api/v1/health", "health"],
      ["POST", "/api/v1/auth/config", "auth_config"],
      ["POST", "/api/v1/demo", "demo_discovery"],
      ["POST", "/api/v1/public-pages/public_1", "public_page_data"],
      ["POST", "/api/v1/projects/project_1/sessions", "sessions_list"],
      ["POST", "/api/v1/projects/project_1/sessions/session_1/live", "live"],
      ["PUT", "/api/v1/projects/project_1/keys/key_1", "project_key"],
      ["HEAD", "/api/v1/projects/project_1/sessions/session_1/manifest", "manifest"],
    ] as const;

    for (const [method, pathname, routeName] of ordinaryMismatches) {
      expect(matchDashboardRequest(method, pathname)).toMatchObject({
        action: "not_found",
        routeName,
        methodAllowed: false,
        authentication: "dashboard",
        access: "authenticated",
        projectRoute: null,
      });
    }

    expect(matchDashboardRequest("PATCH", "/api/v1/projects/project_1/config")).toMatchObject({
      action: "project_config_method_not_allowed",
      routeName: "project_config",
      methodAllowed: false,
      access: "project",
      projectRoute: "project_config_read",
      responsePolicy: "none",
    });
  });

  it("keeps broad demo project extraction separate from exact route and id validation", () => {
    expect(matchDashboardRequest("GET", "/api/v1/projects/demo_project/unknown")).toMatchObject({
      action: "not_found",
      routeName: "not_found",
      projectIdForAuth: "demo_project",
    });
    expect(matchDashboardRequest("GET", "/api/v1/projects/project_1/sessions/")).toMatchObject({
      action: "not_found",
      routeName: "not_found",
      projectIdForAuth: "project_1",
    });
    expect(
      matchDashboardRequest(
        "GET",
        "/api/v1/projects/project_1/sessions/session_1/segments/..%2Fmanifest.json",
      ),
    ).toMatchObject({
      action: "segment",
      projectIdValid: true,
      sessionIdValid: true,
      segmentNameValid: false,
    });
    expect(matchDashboardRequest("GET", "/api/v1/public-pages/bad%2Fid")).toMatchObject({
      action: "public_page_data",
      publicIdValid: false,
    });
  });

  it("owns the exact demo and manager access matrix", () => {
    const expected: Readonly<
      Record<DashboardProjectRouteName, ReturnType<typeof projectRouteAccess>>
    > = {
      sessions_list: { demoReadable: true, minimumRole: "member" },
      session_heads: { demoReadable: true, minimumRole: "member" },
      session_state: { demoReadable: true, minimumRole: "member" },
      project_stats: { demoReadable: true, minimumRole: "member" },
      project_live: { demoReadable: true, minimumRole: "member" },
      project_config_read: { demoReadable: false, minimumRole: "member" },
      project_config_write: { demoReadable: false, minimumRole: "manager" },
      public_page_read: { demoReadable: false, minimumRole: "manager" },
      public_page_write: { demoReadable: false, minimumRole: "manager" },
      install_status: { demoReadable: false, minimumRole: "member" },
      project_keys: { demoReadable: false, minimumRole: "manager" },
      manifest: { demoReadable: true, minimumRole: "member" },
      live_ticket: { demoReadable: true, minimumRole: "member" },
      segment: { demoReadable: true, minimumRole: "member" },
    };

    for (const [routeName, access] of Object.entries(expected)) {
      expect(projectRouteAccess(routeName as DashboardProjectRouteName)).toEqual(access);
    }
  });
});

describe("dashboard request policy handler order", () => {
  it("rate limits a public request before rejecting its invalid id", async () => {
    mocks.publicPageRateLimitAllows.mockResolvedValue(false);
    const limited = await apiRequest("/api/v1/public-pages/bad%2Fid");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(mocks.checkAuth).not.toHaveBeenCalled();
    expect(mocks.getPublicPageDataResponse).not.toHaveBeenCalled();

    mocks.publicPageRateLimitAllows.mockResolvedValue(true);
    const invalid = await apiRequest("/api/v1/public-pages/bad%2Fid");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_path_id" });
    expect(mocks.getPublicPageDataResponse).not.toHaveBeenCalled();
  });

  it("validates ticket-live ids before auth but authenticates private ids first", async () => {
    mocks.checkAuth.mockResolvedValue({ ok: false, status: 503, error: "auth_not_configured" });

    const live = await apiRequest("/api/v1/projects/bad%2Fid/sessions/session_1/live");
    expect(live.status).toBe(400);
    expect(await live.json()).toEqual({ error: "invalid_path_id" });
    expect(mocks.checkAuth).not.toHaveBeenCalled();
    expect(mocks.proxyLiveSession).not.toHaveBeenCalled();

    const unavailable = await apiRequest("/api/v1/projects/bad%2Fid/sessions/session_1/manifest");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "auth_not_configured" });

    mocks.checkAuth.mockResolvedValue({ ok: false, status: 401, error: "unauthorized" });
    const unauthorized = await apiRequest("/api/v1/projects/bad%2Fid/sessions/session_1/manifest");
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
  });

  it("checks project access before a private segment name", async () => {
    mocks.projectAuthError.mockReturnValue(jsonResponse({ error: "forbidden" }, 403));
    const forbidden = await apiRequest(
      "/api/v1/projects/project_1/sessions/session_1/segments/..%2Fmanifest.json",
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
    expect(mocks.getSegment).not.toHaveBeenCalled();

    mocks.projectAuthError.mockReturnValue(null);
    const invalid = await apiRequest(
      "/api/v1/projects/project_1/sessions/session_1/segments/..%2Fmanifest.json",
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_segment_name" });
    expect(mocks.getSegment).not.toHaveBeenCalled();
  });

  it("checks project access before a mutation origin", async () => {
    mocks.isTrustedMutationOrigin.mockReturnValue(false);
    mocks.projectAuthError.mockReturnValue(jsonResponse({ error: "forbidden" }, 403));
    const forbidden = await apiRequest("/api/v1/projects/project_1/config", {
      method: "PUT",
      body: "{}",
    });
    expect(forbidden.status).toBe(403);
    expect(mocks.isTrustedMutationOrigin).not.toHaveBeenCalled();
    expect(mocks.putProjectConfig).not.toHaveBeenCalled();

    mocks.projectAuthError.mockReturnValue(null);
    const untrusted = await apiRequest("/api/v1/projects/project_1/config", {
      method: "PUT",
      body: "{}",
    });
    expect(untrusted.status).toBe(403);
    expect(await untrusted.json()).toEqual({ error: "untrusted_origin" });
    expect(mocks.isTrustedMutationOrigin).toHaveBeenCalledOnce();
    expect(mocks.putProjectConfig).not.toHaveBeenCalled();
  });

  it("applies the demo limiter before unknown and mismatched denial but rejects authorization first", async () => {
    mocks.checkAuth.mockImplementation(async (request: Request) =>
      request.headers.has("authorization")
        ? { ok: false, status: 401, error: "unauthorized" }
        : demoAuth("demo_project"),
    );
    mocks.demoRateLimitAllows.mockResolvedValue(false);

    const unknown = await apiRequest("/api/v1/projects/demo_project/unknown");
    expect(unknown.status).toBe(429);
    expect(await unknown.json()).toEqual({ error: "rate_limited" });

    const mismatch = await apiRequest("/api/v1/projects/demo_project/sessions", {
      method: "POST",
    });
    expect(mismatch.status).toBe(429);
    expect(await mismatch.json()).toEqual({ error: "rate_limited" });
    expect(mocks.demoRateLimitAllows).toHaveBeenCalledTimes(2);

    mocks.demoRateLimitAllows.mockClear();
    const authorization = await apiRequest("/api/v1/projects/demo_project/unknown", {
      headers: { authorization: "Bearer old-dashboard-token" },
    });
    expect(authorization.status).toBe(401);
    expect(await authorization.json()).toEqual({ error: "unauthorized" });
    expect(mocks.demoRateLimitAllows).not.toHaveBeenCalled();
  });

  it("preserves HEAD, trailing slash, ordinary mismatch, and config exception behavior", async () => {
    const head = await apiRequest("/api/v1/health", { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(lastWideEvent()).toMatchObject({ route: "health", status_code: 404 });

    mocks.projectAuthError.mockClear();
    const trailing = await apiRequest("/api/v1/projects/project_1/sessions/");
    expect(trailing.status).toBe(404);
    expect(mocks.projectAuthError).not.toHaveBeenCalled();

    const ordinaryMismatch = await apiRequest("/api/v1/projects/project_1/sessions", {
      method: "POST",
    });
    expect(ordinaryMismatch.status).toBe(404);
    expect(mocks.projectAuthError).not.toHaveBeenCalled();
    expect(lastWideEvent()).toMatchObject({ route: "sessions_list", status_code: 404 });

    const configMismatch = await apiRequest("/api/v1/projects/project_1/config", {
      method: "PATCH",
    });
    expect(configMismatch.status).toBe(404);
    expect(mocks.projectAuthError).toHaveBeenCalledWith(
      expect.anything(),
      "project_1",
      "project_config_read",
    );
    expect(lastWideEvent()).toMatchObject({
      route: "project_config",
      project_id: "project_1",
      status_code: 404,
    });
  });

  it("wraps authenticated domain errors but leaves early and demo errors unwrapped", async () => {
    const authenticated = await apiRequest(
      "/api/v1/projects/project_1/sessions/session_1/manifest",
    );
    expect(authenticated.status).toBe(404);
    expect(authenticated.headers.get("vary")).toBe("Cookie");
    expect(authenticated.headers.get("cache-control")).toBe(
      "private, max-age=300, must-revalidate",
    );

    const early = await apiRequest("/api/v1/projects/project_1/sessions/bad%2Fid/manifest");
    expect(early.status).toBe(400);
    expect(early.headers.get("vary")).toBeNull();
    expect(early.headers.get("cache-control")).toBeNull();

    mocks.checkAuth.mockResolvedValue(demoAuth("project_1"));
    const demo = await apiRequest("/api/v1/projects/project_1/sessions/session_1/manifest");
    expect(demo.status).toBe(404);
    expect(demo.headers.get("vary")).toBeNull();
    expect(demo.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
  });

  it("runs analytics limiting only after auth and project access, and only for sessions and stats", async () => {
    mocks.checkAuth.mockResolvedValue({ ok: false, status: 401, error: "unauthorized" });
    expect((await apiRequest("/api/v1/projects/project_1/sessions")).status).toBe(401);
    expect(mocks.checkAnalyticsReadRateLimit).not.toHaveBeenCalled();

    mocks.checkAuth.mockResolvedValue(sessionAuth());
    mocks.projectAuthError.mockReturnValue(jsonResponse({ error: "forbidden" }, 403));
    expect((await apiRequest("/api/v1/projects/project_1/sessions")).status).toBe(403);
    expect(mocks.checkAnalyticsReadRateLimit).not.toHaveBeenCalled();

    mocks.projectAuthError.mockReturnValue(null);
    mocks.checkAnalyticsReadRateLimit.mockResolvedValue({
      allowed: false,
      scope: "project",
    });
    const sessions = await apiRequest("/api/v1/projects/project_1/sessions");
    expect(sessions.status).toBe(429);
    expect(sessions.headers.get("retry-after")).toBe("60");
    expect(mocks.checkAnalyticsReadRateLimit).toHaveBeenCalledOnce();

    mocks.checkAnalyticsReadRateLimit.mockClear();
    const stats = await apiRequest("/api/v1/projects/project_1/stats");
    expect(stats.status).toBe(429);
    expect(mocks.checkAnalyticsReadRateLimit).toHaveBeenCalledOnce();

    mocks.checkAnalyticsReadRateLimit.mockClear();
    mocks.checkAnalyticsReadRateLimit.mockResolvedValue({ allowed: true });
    expect((await apiRequest("/api/v1/projects/project_1/session-heads")).status).toBe(200);
    expect((await apiRequest("/api/v1/projects/project_1/live")).status).toBe(200);
    expect(mocks.checkAnalyticsReadRateLimit).not.toHaveBeenCalled();
  });
});

interface ExpectedPolicy {
  access?: string;
  handlerRateLimit?: string;
  keyId?: string;
  projectId?: string;
  projectRoute?: string;
  publicId?: string;
  publicReplayId?: string;
  requiresSessionAuth?: boolean;
  requiresTrustedMutationOrigin?: boolean;
  responsePolicy?: string;
  segmentName?: string;
  sessionId?: string;
}

function route(
  method: string,
  pathname: string,
  action: string,
  routeName: string,
  authentication: string,
  expected: ExpectedPolicy = {},
) {
  return { method, pathname, action, routeName, authentication, expected };
}

function projectRoute(
  method: string,
  suffix: string,
  action: string,
  routeName: string,
  projectRouteName: DashboardProjectRouteName,
  expected: ExpectedPolicy = {},
) {
  return route(method, `/api/v1/projects/project_1${suffix}`, action, routeName, "dashboard", {
    access: "project",
    projectId: "project_1",
    projectRoute: projectRouteName,
    responsePolicy: "authenticated_project",
    ...expected,
  });
}

function sessionAuth(projectId = "project_1"): ApiAuthContext {
  return {
    ok: true,
    mode: "session",
    projects: new Set([projectId]),
    projectRoles: new Map([[projectId, "owner"]]),
    hostedSession: { user: { id: "user_1" } },
    globalAdmin: false,
  } as unknown as ApiAuthContext;
}

function demoAuth(projectId: string): ApiAuthContext {
  return { ok: true, mode: "demo", projects: new Set([projectId]) };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function apiRequest(pathname: string, init: RequestInit = {}): Promise<Response> {
  return handleApi(new Request(`https://replay.test${pathname}`, init), testEnv, executionContext);
}

function lastWideEvent(): Record<string, unknown> {
  const calls = vi.mocked(console.log).mock.calls;
  return JSON.parse(String(calls.at(-1)?.[0])) as Record<string, unknown>;
}
