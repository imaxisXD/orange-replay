import { describe, expect, it } from "vite-plus/test";
import { isTrustedMutationOrigin } from "../src/auth/config.ts";
import type { Env } from "../src/env.ts";
import {
  globalAdminAuthError,
  projectAuthError,
  type ProjectRole,
  type SessionAuthContext,
} from "../src/api/auth.ts";
import type { HostedSession } from "../src/auth/server.ts";

describe("hosted project authorization", () => {
  it("lets members read a project but not change config or keys", async () => {
    const auth = sessionAuth(new Map([["project_1", "member"]]));

    expect(projectAuthError(auth, "project_1", "sessions_list")).toBeNull();
    expect(projectAuthError(auth, "project_1", "project_config_read")).toBeNull();
    await expectError(projectAuthError(auth, "project_1", "project_config_write"), 403);
    await expectError(projectAuthError(auth, "project_1", "project_keys"), 403);
    await expectError(projectAuthError(auth, "project_1", "public_page_read"), 403);
    await expectError(projectAuthError(auth, "project_1", "public_page_write"), 403);
  });

  it("lets workspace owners and admins manage keys", () => {
    for (const role of ["owner", "admin"] as const) {
      const auth = sessionAuth(new Map([["project_1", role]]));
      expect(projectAuthError(auth, "project_1", "project_config_write")).toBeNull();
      expect(projectAuthError(auth, "project_1", "project_keys")).toBeNull();
      expect(projectAuthError(auth, "project_1", "public_page_read")).toBeNull();
      expect(projectAuthError(auth, "project_1", "public_page_write")).toBeNull();
    }
  });

  it("does not grant a session access outside its memberships", async () => {
    const auth = sessionAuth(new Map([["project_1", "owner"]]));
    await expectError(projectAuthError(auth, "project_2", "sessions_list"), 403);
  });

  it("guards operator APIs with the global admin flag", async () => {
    const normalUser = sessionAuth(new Map());
    await expectError(globalAdminAuthError(normalUser), 403);

    const operator = { ...normalUser, globalAdmin: true };
    expect(globalAdminAuthError(operator)).toBeNull();
  });
});

describe("hosted mutation origins", () => {
  it("accepts only an exact trusted origin", () => {
    const env = hostedEnv();
    expect(
      isTrustedMutationOrigin(
        new Request("https://replay.example/api/v1/account/bootstrap", {
          method: "POST",
          headers: { origin: "https://replay.example" },
        }),
        env,
      ),
    ).toBe(true);

    for (const origin of [
      "https://replay.example.attacker.test",
      "https://replay.example/path",
      "null",
    ]) {
      expect(
        isTrustedMutationOrigin(
          new Request("https://replay.example/api/v1/account/bootstrap", {
            method: "POST",
            headers: { origin },
          }),
          env,
        ),
      ).toBe(false);
    }

    expect(
      isTrustedMutationOrigin(
        new Request("https://replay.example/api/v1/account/bootstrap", { method: "POST" }),
        env,
      ),
    ).toBe(false);
  });
});

function sessionAuth(projectRoles: ReadonlyMap<string, ProjectRole>): SessionAuthContext {
  return {
    ok: true,
    mode: "session",
    projects: new Set(projectRoles.keys()),
    projectRoles,
    hostedSession: hostedSession(),
    globalAdmin: false,
  };
}

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

async function expectError(response: Response | null, status: number): Promise<void> {
  expect(response).not.toBeNull();
  if (response === null) return;
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: "forbidden" });
}

function hostedEnv(): Env {
  return {
    WORKER_ENV: "production",
    BETTER_AUTH_URL: "https://replay.example",
    BETTER_AUTH_SECRET: "test-secret-that-is-longer-than-32-characters",
    BETTER_AUTH_TRUSTED_ORIGINS: "https://replay.example",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
  } as Env;
}
