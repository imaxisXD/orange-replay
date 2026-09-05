import { accountResponseSchema } from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  authHeaders,
  betterAuthOrigin,
  listProjectId,
  setupApiTestWorkers,
  worker,
} from "./api-test-helpers.ts";

setupApiTestWorkers();

describe("Better Auth session flow", () => {
  it("restores a session, lists workspaces, starts GitHub sign-in, and signs out", async () => {
    const originalHeaders = authHeaders();
    const sessionResponse = await worker.fetch("/api/auth/get-session", {
      headers: originalHeaders,
    });
    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.headers.get("cache-control")).toBe("no-store");
    expect(await sessionResponse.json()).toMatchObject({
      user: {
        id: "test_dashboard_user",
        name: "Test dashboard user",
        email: "dashboard-test@example.com",
        emailVerified: true,
        role: "user",
        banned: false,
      },
      session: {
        id: "test_dashboard_session",
        userId: "test_dashboard_user",
        activeOrganizationId: "api_org",
      },
    });

    const organizationsResponse = await worker.fetch("/api/auth/organization/list", {
      headers: originalHeaders,
    });
    expect(organizationsResponse.status).toBe(200);
    const organizations = await organizationsResponse.json();
    expect(organizations).toHaveLength(2);
    expect(organizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "api_org", name: "api_org" }),
        expect.objectContaining({
          id: "test_dashboard_workspace",
          name: "Test dashboard workspace",
          slug: "test_dashboard_workspace",
        }),
      ]),
    );

    const accountResponse = await worker.fetch("/api/v1/account", { headers: originalHeaders });
    expect(accountResponse.status).toBe(200);
    const account = accountResponseSchema.parse(await accountResponse.json());
    expect(account.user.id).toBe("test_dashboard_user");
    expect(account.activeWorkspaceId).toBe("api_org");
    expect(account.workspaces.find((workspace) => workspace.id === "api_org")?.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: listProjectId, name: listProjectId, role: "owner" }),
      ]),
    );

    const signInResponse = await worker.fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { ...originalHeaders, "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", callbackURL: `${betterAuthOrigin}/projects` }),
      redirect: "manual",
    });
    expect(signInResponse.status).toBe(200);
    const signIn = (await signInResponse.json()) as { url?: unknown; redirect?: unknown };
    expect(signIn.redirect).toBe(true);
    expect(signIn.url).toEqual(expect.any(String));
    if (typeof signIn.url !== "string") throw new Error("The GitHub sign-in URL is missing.");
    expect(signInResponse.headers.get("location")).toBe(signIn.url);
    const signInUrl = new URL(signIn.url);
    expect(signInUrl.origin).toBe("https://github.com");
    expect(signInUrl.pathname).toBe("/login/oauth/authorize");
    expect(signInUrl.searchParams.get("client_id")).toBe("github-test-client-id");
    expect(signInUrl.searchParams.get("redirect_uri")).toBe(
      `${betterAuthOrigin}/api/auth/callback/github`,
    );
    expect(signInUrl.searchParams.get("response_type")).toBe("code");
    expect(signInUrl.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "read:user",
      "user:email",
    ]);
    expect(signInUrl.searchParams.get("state")).toEqual(expect.stringMatching(/\S/));

    const signOutResponse = await worker.fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { ...originalHeaders, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(signOutResponse.status).toBe(200);
    expect(await signOutResponse.json()).toEqual({ success: true });
    expect(signOutResponse.headers.get("set-cookie")).toMatch(
      /orange-replay\.session_token=;[^,]*Max-Age=0/i,
    );

    const signedOutSession = await worker.fetch("/api/auth/get-session", {
      headers: originalHeaders,
    });
    expect(signedOutSession.status).toBe(200);
    expect(await signedOutSession.json()).toBeNull();

    const signedOutAccount = await worker.fetch("/api/v1/account", { headers: originalHeaders });
    expect(signedOutAccount.status).toBe(401);
    expect(await signedOutAccount.json()).toEqual({ error: "unauthorized" });
  });
});
