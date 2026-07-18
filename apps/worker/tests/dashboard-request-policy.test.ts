import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ApiAuthContext } from "../src/api/auth.ts";
import {
  matchDashboardRequest,
  projectRouteAccess,
  type DashboardProjectRouteName,
  type DashboardRouteName,
  type ProjectRoutePlan,
} from "../src/api/dashboard-request-policy.ts";
import type { Env } from "../src/env.ts";
import { handleApi } from "../src/api/handler.ts";
import type { DashboardExecutors, DashboardRouteContext } from "../src/api/dashboard-routes.ts";

const mocks = vi.hoisted(() => ({
  checkAuth: vi.fn(),
  demoRateLimitAllows: vi.fn(),
  projectAuthError: vi.fn(),
  isTrustedMutationOrigin: vi.fn(),
  checkAnalyticsReadRateLimit: vi.fn(),
  publicPageRateLimitAllows: vi.fn(),
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
  getPublicPageDataResponse: vi.fn(),
  getPublicManifest: vi.fn(),
  getPublicSegment: vi.fn(),
  publicPageRateLimitAllows: mocks.publicPageRateLimitAllows,
}));

const executionContext = {} as Parameters<typeof handleApi>[2];
const testEnv = { WORKER_ENV: "test", DEV_TEST_ROUTES: "1" } as Env;

function fakeExecutors() {
  return {
    betterAuth: vi.fn(async () => new Response("auth")),
    demoDiscovery: vi.fn(async () => jsonResponse({ projectId: "demo" })),
    publicPage: vi.fn(async () => jsonResponse({ ok: true })),
    liveProxy: vi.fn(async () => new Response("live")),
    account: vi.fn(async () => jsonResponse({ ok: true })),
    accountBootstrap: vi.fn(async () => jsonResponse({ ok: true })),
    adminStats: vi.fn(async () => jsonResponse({ ok: true })),
    adminUsers: vi.fn(async () => jsonResponse({ ok: true })),
    project: vi.fn(
      async (_rctx: DashboardRouteContext, _auth: ApiAuthContext, route: ProjectRoutePlan) =>
        route.action === "manifest"
          ? jsonResponse({ error: "not_found" }, 404, {
              "cache-control": "public, max-age=300, must-revalidate",
            })
          : jsonResponse({ ok: true }),
    ),
  } satisfies DashboardExecutors;
}

let executors: ReturnType<typeof fakeExecutors>;

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
  executors = fakeExecutors();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dashboard request plans", () => {
  it("plans every non-project route with its authentication family and ids", () => {
    expect(matchDashboardRequest("GET", "/api/v1/health")).toEqual({
      kind: "public",
      routeName: "health",
      action: "health",
    });
    expect(matchDashboardRequest("DELETE", "/api/auth/session")).toEqual({
      kind: "better_auth",
      routeName: "better_auth",
    });
    expect(matchDashboardRequest("GET", "/api/v1/auth/config")).toEqual({
      kind: "public",
      routeName: "auth_config",
      action: "auth_config",
    });
    expect(matchDashboardRequest("GET", "/api/v1/demo")).toEqual({
      kind: "public",
      routeName: "demo_discovery",
      action: "demo_discovery",
    });
    expect(matchDashboardRequest("GET", "/api/v1/public-pages/public_1")).toEqual({
      kind: "public_page",
      routeName: "public_page_data",
      action: "page_data",
      params: { ok: true, ids: { publicId: "public_1" } },
    });
    expect(
      matchDashboardRequest("GET", "/api/v1/public-pages/public_1/replays/replay_1/manifest"),
    ).toEqual({
      kind: "public_page",
      routeName: "public_manifest",
      action: "manifest",
      params: { ok: true, ids: { publicId: "public_1", publicReplayId: "replay_1" } },
    });
    expect(
      matchDashboardRequest(
        "GET",
        "/api/v1/public-pages/public_1/replays/replay_1/segments/seg-000001.ors",
      ),
    ).toEqual({
      kind: "public_page",
      routeName: "public_segment",
      action: "segment",
      params: {
        ok: true,
        ids: { publicId: "public_1", publicReplayId: "replay_1", segmentName: "seg-000001.ors" },
      },
    });
    expect(
      matchDashboardRequest("GET", "/api/v1/projects/project_1/sessions/session_1/live"),
    ).toEqual({
      kind: "ticket_live",
      routeName: "live",
      params: { ok: true, ids: { projectId: "project_1", sessionId: "session_1" } },
    });
    expect(matchDashboardRequest("GET", "/api/v1/account")).toEqual({
      kind: "authed",
      routeName: "account",
      projectIdForAuth: null,
      route: { access: "session", action: "account", mutationOrigin: false },
    });
    expect(matchDashboardRequest("POST", "/api/v1/account/bootstrap")).toEqual({
      kind: "authed",
      routeName: "account_bootstrap",
      projectIdForAuth: null,
      route: { access: "session", action: "account_bootstrap", mutationOrigin: true },
    });
    expect(matchDashboardRequest("GET", "/api/v1/admin/stats")).toEqual({
      kind: "authed",
      routeName: "admin_stats",
      projectIdForAuth: null,
      route: { access: "global_admin", action: "admin_stats", mutationOrigin: false },
    });
    expect(matchDashboardRequest("GET", "/api/v1/admin/users")).toEqual({
      kind: "authed",
      routeName: "admin_users",
      projectIdForAuth: null,
      route: { access: "global_admin", action: "admin_users", mutationOrigin: false },
    });
  });

  it("plans every project route with its role key, limits, origin, response, and ids", () => {
    const cases: readonly [string, string, DashboardRouteName, ProjectRoutePlan][] = [
      [
        "GET",
        "/sessions",
        "sessions_list",
        plannedProject("sessions_list", "sessions_list", { analyticsReadLimit: true }),
      ],
      ["GET", "/session-heads", "session_heads", plannedProject("session_heads", "session_heads")],
      [
        "GET",
        "/stats",
        "project_stats",
        plannedProject("project_stats", "project_stats", { analyticsReadLimit: true }),
      ],
      ["GET", "/live", "project_live", plannedProject("project_live", "project_live")],
      [
        "GET",
        "/config",
        "project_config",
        plannedProject("project_config_read", "project_config_read"),
      ],
      [
        "PUT",
        "/config",
        "project_config",
        plannedProject("project_config_write", "project_config_write", { mutationOrigin: true }),
      ],
      [
        "GET",
        "/install-status",
        "install_status",
        plannedProject("install_status", "install_status"),
      ],
      [
        "GET",
        "/public-page",
        "public_page_settings",
        plannedProject("public_page_read", "public_page_read"),
      ],
      [
        "PUT",
        "/public-page",
        "public_page_settings",
        plannedProject("public_page_write", "public_page_write", { mutationOrigin: true }),
      ],
      [
        "GET",
        "/keys",
        "project_keys",
        plannedProject("project_keys", "project_keys_read", { sessionAuthRequired: true }),
      ],
      [
        "POST",
        "/keys",
        "project_keys",
        plannedProject("project_keys", "project_keys_create", {
          sessionAuthRequired: true,
          mutationOrigin: true,
        }),
      ],
      [
        "DELETE",
        "/keys/key_1",
        "project_key",
        plannedProject(
          "project_keys",
          "project_key_revoke",
          { sessionAuthRequired: true, mutationOrigin: true },
          { projectId: "project_1", keyId: "key_1" },
        ),
      ],
      [
        "GET",
        "/sessions/session_1/manifest",
        "manifest",
        plannedProject(
          "manifest",
          "manifest",
          {},
          { projectId: "project_1", sessionId: "session_1" },
        ),
      ],
      [
        "GET",
        "/sessions/session_1/state",
        "session_state",
        plannedProject(
          "session_state",
          "session_state",
          {},
          { projectId: "project_1", sessionId: "session_1" },
        ),
      ],
      [
        "POST",
        "/sessions/session_1/live-ticket",
        "live_ticket",
        plannedProject(
          "live_ticket",
          "live_ticket",
          { mutationOrigin: true },
          { projectId: "project_1", sessionId: "session_1" },
        ),
      ],
      [
        "GET",
        "/sessions/session_1/segments/seg-000001.ors",
        "segment",
        plannedProject(
          "segment",
          "segment",
          {},
          { projectId: "project_1", sessionId: "session_1", segmentName: "seg-000001.ors" },
        ),
      ],
    ];

    for (const [method, suffix, routeName, route] of cases) {
      const pathname = `/api/v1/projects/project_1${suffix}`;
      expect(matchDashboardRequest(method, pathname), `${method} ${pathname}`).toEqual({
        kind: "authed",
        routeName,
        projectIdForAuth: "project_1",
        route,
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
      expect(matchDashboardRequest(method, pathname), `${method} ${pathname}`).toEqual({
        kind: "authed",
        routeName,
        projectIdForAuth: /^\/api\/v1\/projects\/([^/]+)/.exec(pathname)?.[1] ?? null,
        route: { access: "authenticated", action: "not_found", mutationOrigin: false },
      });
    }

    expect(matchDashboardRequest("PATCH", "/api/v1/projects/project_1/config")).toEqual({
      kind: "authed",
      routeName: "project_config",
      projectIdForAuth: "project_1",
      route: plannedProject("project_config_read", "project_config_method_not_allowed", {
        authenticatedResponse: false,
      }),
    });
  });

  it("keeps broad demo project extraction separate from exact route and id validation", () => {
    expect(matchDashboardRequest("GET", "/api/v1/projects/demo_project/unknown")).toEqual({
      kind: "authed",
      routeName: "not_found",
      projectIdForAuth: "demo_project",
      route: { access: "authenticated", action: "not_found", mutationOrigin: false },
    });
    expect(matchDashboardRequest("GET", "/api/v1/projects/project_1/sessions/")).toEqual({
      kind: "authed",
      routeName: "not_found",
      projectIdForAuth: "project_1",
      route: { access: "authenticated", action: "not_found", mutationOrigin: false },
    });
    expect(
      matchDashboardRequest(
        "GET",
        "/api/v1/projects/project_1/sessions/session_1/segments/..%2Fmanifest.json",
      ),
    ).toMatchObject({
      route: {
        action: "segment",
        params: {
          ok: false,
          error: "invalid_segment_name",
          ids: { projectId: "project_1", sessionId: "session_1" },
        },
      },
    });
    expect(
      matchDashboardRequest("GET", "/api/v1/projects/bad%2Fid/sessions/session_1/manifest"),
    ).toMatchObject({
      projectIdForAuth: "bad%2Fid",
      route: { action: "manifest", params: { ok: false, error: "invalid_path_id" } },
    });
    expect(matchDashboardRequest("GET", "/api/v1/public-pages/bad%2Fid")).toMatchObject({
      action: "page_data",
      params: { ok: false, error: "invalid_path_id", logged: {} },
    });
    expect(
      matchDashboardRequest("GET", "/api/v1/public-pages/public_1/replays/bad%2Fid/manifest"),
    ).toMatchObject({
      action: "manifest",
      params: { ok: false, error: "invalid_path_id", logged: { publicId: "public_1" } },
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
    expect(executors.publicPage).not.toHaveBeenCalled();

    mocks.publicPageRateLimitAllows.mockResolvedValue(true);
    const invalid = await apiRequest("/api/v1/public-pages/bad%2Fid");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_path_id" });
    expect(executors.publicPage).not.toHaveBeenCalled();
  });

  it("validates ticket-live ids before auth but authenticates private ids first", async () => {
    mocks.checkAuth.mockResolvedValue({ ok: false, status: 503, error: "auth_not_configured" });

    const live = await apiRequest("/api/v1/projects/bad%2Fid/sessions/session_1/live");
    expect(live.status).toBe(400);
    expect(await live.json()).toEqual({ error: "invalid_path_id" });
    expect(mocks.checkAuth).not.toHaveBeenCalled();
    expect(executors.liveProxy).not.toHaveBeenCalled();

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
    expect(executors.project).not.toHaveBeenCalled();

    mocks.projectAuthError.mockReturnValue(null);
    const invalid = await apiRequest(
      "/api/v1/projects/project_1/sessions/session_1/segments/..%2Fmanifest.json",
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_segment_name" });
    expect(executors.project).not.toHaveBeenCalled();
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
    expect(executors.project).not.toHaveBeenCalled();

    mocks.projectAuthError.mockReturnValue(null);
    const untrusted = await apiRequest("/api/v1/projects/project_1/config", {
      method: "PUT",
      body: "{}",
    });
    expect(untrusted.status).toBe(403);
    expect(await untrusted.json()).toEqual({ error: "untrusted_origin" });
    expect(mocks.isTrustedMutationOrigin).toHaveBeenCalledOnce();
    expect(executors.project).not.toHaveBeenCalled();
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

function plannedProject(
  route: DashboardProjectRouteName,
  action: ProjectRoutePlan["action"],
  overrides: Partial<
    Pick<
      ProjectRoutePlan,
      "sessionAuthRequired" | "mutationOrigin" | "analyticsReadLimit" | "authenticatedResponse"
    >
  > = {},
  ids: { projectId: string; sessionId?: string; segmentName?: string; keyId?: string } = {
    projectId: "project_1",
  },
): ProjectRoutePlan {
  return {
    access: "project",
    route,
    sessionAuthRequired: false,
    mutationOrigin: false,
    analyticsReadLimit: false,
    authenticatedResponse: true,
    ...overrides,
    action,
    params: { ok: true, ids },
  } as ProjectRoutePlan;
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
  return handleApi(
    new Request(`https://replay.test${pathname}`, init),
    testEnv,
    executionContext,
    executors,
  );
}

function lastWideEvent(): Record<string, unknown> {
  const calls = vi.mocked(console.log).mock.calls;
  return JSON.parse(String(calls.at(-1)?.[0])) as Record<string, unknown>;
}
