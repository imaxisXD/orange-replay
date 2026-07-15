// @vitest-environment happy-dom
import type { SessionManifest } from "@orange-replay/shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  clearDashboardAccess,
  dashboardPlayerAccess,
  dashboardRequestAccess,
  decideProjectRoute,
  readDashboardAccess,
  signOutDashboardAccess,
  startGithubSignIn,
} from "../src/lib/dashboard-access";
import { dashboardPlayerApi } from "../src/routes/session-detail/replay-player-runtime";

beforeEach(() => {
  clearDashboardAccess();
  window.history.replaceState({}, "", "/projects/project_one/overview");
  window.localStorage.clear();
});

afterEach(() => {
  clearDashboardAccess();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("dashboard access adapters", () => {
  it("maps Better Auth, demo, and unavailable modes without browser token state", () => {
    expect(readDashboardAccess("private", "github").adapter).toBe("hosted-cookie");
    expect(readDashboardAccess("private", "unavailable").adapter).toBe("unavailable");
    expect(readDashboardAccess("demo", "github").adapter).toBe("demo");
    expect(window.localStorage.length).toBe(0);
  });

  it("keeps demo and private request access separate", () => {
    expect(dashboardRequestAccess({ scope: "demo" }).adapter).toBe("demo");
    expect(dashboardRequestAccess({ scope: "private" }).adapter).toBe("hosted-cookie");
  });

  it("keeps project membership and manager decisions in the access module", () => {
    expect(decideProjectRoute({ projectId: "p1", requirement: "view", scope: "private" })).toEqual({
      action: "load-account",
    });

    const memberAccount = {
      isAdmin: false,
      workspaces: [{ projects: [{ id: "p1", role: "member" as const }] }],
    };
    expect(
      decideProjectRoute({
        account: memberAccount,
        projectId: "p1",
        requirement: "view",
        scope: "private",
      }),
    ).toEqual({ action: "allow" });
    expect(
      decideProjectRoute({
        account: memberAccount,
        projectId: "p1",
        requirement: "manage",
        scope: "private",
      }),
    ).toEqual({ action: "redirect-overview" });
  });

  it("uses cookies for private player requests and strips stale auth headers from demo", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const privateAccess = dashboardPlayerAccess(false);
    const privateApi = dashboardPlayerApi(manifest(), privateAccess);
    await privateApi.fetch?.("/api/v1/projects/p1/sessions/s1/segments/seg-1.ors");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBeNull();

    const demoAccess = dashboardPlayerAccess(true);
    const demoApi = dashboardPlayerApi(manifest(), demoAccess);
    await demoApi.fetch?.("/api/v1/projects/p1/sessions/s1/segments/seg-1.ors", {
      headers: { authorization: "Bearer player-token" },
    });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization")).toBeNull();
  });

  it("owns Better Auth sign-out and GitHub sign-in transitions", async () => {
    const signOut = vi.fn().mockResolvedValue({ data: null, error: null });

    await signOutDashboardAccess({ signOut });

    expect(signOut).toHaveBeenCalledOnce();

    const social = vi.fn().mockResolvedValue({ data: null, error: null });
    await startGithubSignIn(
      {
        callbackURL: "https://app.example/projects",
        errorCallbackURL: "https://app.example/login?reason=unauthorized",
        newUserCallbackURL: "https://app.example/projects",
      },
      { signIn: { social } },
    );
    expect(social).toHaveBeenCalledWith({
      provider: "github",
      callbackURL: "https://app.example/projects",
      errorCallbackURL: "https://app.example/login?reason=unauthorized",
      newUserCallbackURL: "https://app.example/projects",
    });
  });
});

function manifest(): SessionManifest {
  return {
    v: 1,
    sessionId: "s1",
    projectId: "p1",
    orgId: "o1",
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    segments: [],
    timeline: [],
    counts: { batches: 0, events: 0, clicks: 0, errors: 0, rages: 0, navs: 0 },
    bytes: 0,
    flags: 0,
    attrs: {},
  };
}
