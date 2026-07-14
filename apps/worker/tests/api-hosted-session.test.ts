import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { HostedSession } from "../src/auth/server.ts";
import type { Env } from "../src/env.ts";

type TestDatabase = Env["IDX_00"];

const authMocks = vi.hoisted(() => ({
  getHostedSession: vi.fn(),
  isGlobalAdmin: vi.fn(() => false),
}));

vi.mock("../src/auth/server.ts", () => authMocks);

import { checkAuth } from "../src/api/auth.ts";

beforeEach(() => {
  authMocks.getHostedSession.mockReset();
  authMocks.getHostedSession.mockResolvedValue(hostedSession());
  authMocks.isGlobalAdmin.mockClear();
});

describe("hosted session project lookup", () => {
  it("loads project access through the signed-in user's workspace memberships", async () => {
    const all = vi.fn(async () => ({
      results: [{ project_id: "project_1", role: "member" }],
      success: true,
      meta: {},
    }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const env = hostedEnv({ prepare } as TestDatabase);

    const auth = await checkAuth(
      new Request("https://replay.example/api/v1/projects/project_1/sessions", {
        headers: { cookie: "orange-replay.session_token=test" },
      }),
      env,
      "project_1",
    );

    expect(auth).toMatchObject({ ok: true, mode: "session", globalAdmin: false });
    if (!auth.ok || auth.mode !== "session") return;
    expect(auth.projects).toEqual(new Set(["project_1"]));
    expect(auth.projectRoles).toEqual(new Map([["project_1", "member"]]));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("FROM members m"));
    expect(bind).toHaveBeenCalledWith("user_1");
  });

  it("never falls through from an explicit bearer header to a hosted session", async () => {
    const auth = await checkAuth(
      new Request("https://replay.example/api/v1/projects/project_1/sessions", {
        headers: { authorization: "Bearer old-local-token" },
      }),
      hostedEnv({} as TestDatabase),
      "project_1",
    );

    expect(auth).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(authMocks.getHostedSession).not.toHaveBeenCalled();
  });
});

function hostedSession(): HostedSession {
  return {
    user: {
      id: "user_1",
      name: "Demo User",
      email: "demo@example.com",
      emailVerified: true,
      image: null,
      role: "user",
      banned: false,
      banReason: null,
      banExpires: null,
    },
    session: {
      id: "session_1",
      userId: "user_1",
      expiresAt: new Date(Date.now() + 60_000),
      activeOrganizationId: "workspace_1",
      impersonatedBy: null,
    },
  };
}

function hostedEnv(database: TestDatabase): Env {
  return {
    IDX_00: database,
    WORKER_ENV: "production",
    BETTER_AUTH_URL: "https://replay.example",
    BETTER_AUTH_SECRET: "test-secret-that-is-longer-than-32-characters",
    BETTER_AUTH_TRUSTED_ORIGINS: "https://replay.example",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
  } as Env;
}
