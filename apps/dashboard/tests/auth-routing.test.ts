// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { canManageProject, clearDashboardAccess } from "../src/lib/dashboard-access";
import { queryClient } from "../src/lib/query";
import { requireProjectAccess, requireProjectManager } from "../src/lib/route-guard";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState({}, "", "/projects/project_one/overview");
  clearDashboardAccess();
  queryClient.clear();
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("hosted project routing", () => {
  it("allows a signed-in member to open an owned project with the session cookie", async () => {
    fetchMock.mockResolvedValue(accountResponse("member"));

    await expect(
      requireProjectAccess(
        {
          href: "/projects/project_one/overview",
          pathname: "/projects/project_one/overview",
        },
        "project_one",
      ),
    ).resolves.toBeUndefined();

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("keeps read-only members out of project settings", async () => {
    fetchMock.mockResolvedValue(accountResponse("member"));

    await expect(
      requireProjectManager(
        {
          href: "/projects/project_one/settings",
          pathname: "/projects/project_one/settings",
        },
        "project_one",
      ),
    ).rejects.toMatchObject({
      status: 307,
      options: { to: "/projects/$projectId/overview" },
    });
  });

  it("allows a workspace owner to manage project settings", async () => {
    fetchMock.mockResolvedValue(accountResponse("owner"));

    await expect(
      requireProjectManager(
        {
          href: "/projects/project_one/settings",
          pathname: "/projects/project_one/settings",
        },
        "project_one",
      ),
    ).resolves.toBeUndefined();
  });

  it("allows only known owners and admins to see manager controls", () => {
    expect(canManageProject(undefined)).toBe(false);
    expect(canManageProject(projectWithRole("member"))).toBe(false);
    expect(canManageProject(projectWithRole("owner"))).toBe(true);
    expect(canManageProject(projectWithRole("admin"))).toBe(true);
  });

  it("allows a workspace admin to manage project settings", async () => {
    fetchMock.mockResolvedValue(accountResponse("admin"));

    await expect(
      requireProjectManager(
        {
          href: "/projects/project_one/settings",
          pathname: "/projects/project_one/settings",
        },
        "project_one",
      ),
    ).resolves.toBeUndefined();
  });
});

function projectWithRole(role: "owner" | "admin" | "member") {
  return { id: "project_one", name: "Default project", role };
}

function accountResponse(role: "owner" | "admin" | "member"): Response {
  return Response.json({
    user: {
      id: "user_one",
      name: "Sunny",
      email: "sunny@example.com",
      emailVerified: true,
      image: null,
      role: "user",
    },
    workspaces: [
      {
        id: "workspace_one",
        name: "Sunny's workspace",
        slug: "sunny",
        role,
        projects: [projectWithRole(role)],
      },
    ],
    activeWorkspaceId: "workspace_one",
    isAdmin: false,
  });
}
