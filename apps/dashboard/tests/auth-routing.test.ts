// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { canManageProject, clearDashboardAccess } from "../src/lib/dashboard-access";
import { queryClient } from "../src/lib/query";
import {
  openProjectsHome,
  requireActivationAccess,
  requireProjectAccess,
  requireProjectManager,
} from "../src/lib/route-guard";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
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

  it("allows an unfinished project to continue onboarding", async () => {
    fetchMock.mockResolvedValueOnce(accountResponse("owner"));

    await expect(
      requireActivationAccess(
        {
          href: "/onboarding/project_one/install",
          pathname: "/onboarding/project_one/install",
        },
        "project_one",
      ),
    ).resolves.toBeUndefined();
  });

  it("allows an activated Workspace to add another Website", async () => {
    fetchMock.mockResolvedValueOnce(accountResponse("owner"));

    await expect(
      requireActivationAccess(
        {
          href: "/onboarding/project_one/install",
          pathname: "/onboarding/project_one/install",
        },
        "project_one",
      ),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resumes a saved first Website at its installation script after login", async () => {
    fetchMock
      .mockResolvedValueOnce(accountResponse("owner"))
      .mockResolvedValueOnce(Response.json({ firstEventAt: null }))
      .mockResolvedValueOnce(projectWebsitesResponse(pendingWebsite()));

    await expect(
      openProjectsHome({ href: "/projects", pathname: "/projects" }),
    ).rejects.toMatchObject({
      status: 307,
      options: {
        to: "/onboarding/$projectId/install",
        params: { projectId: "project_one" },
        search: { website: "website_ndle" },
      },
    });
  });

  it("starts Step 1 only when the Workspace has no Website", async () => {
    fetchMock
      .mockResolvedValueOnce(accountResponse("owner"))
      .mockResolvedValueOnce(Response.json({ firstEventAt: null }))
      .mockResolvedValueOnce(projectWebsitesResponse());

    await expect(
      openProjectsHome({ href: "/projects", pathname: "/projects" }),
    ).rejects.toMatchObject({
      status: 307,
      options: {
        to: "/onboarding/$projectId/website",
        params: { projectId: "project_one" },
      },
    });
  });

  it("trusts durable Website activation when the project-wide check is stale", async () => {
    fetchMock
      .mockResolvedValueOnce(accountResponse("owner"))
      .mockResolvedValueOnce(Response.json({ firstEventAt: null }))
      .mockResolvedValueOnce(projectWebsitesResponse(connectedWebsite()));

    await expect(
      openProjectsHome({ href: "/projects", pathname: "/projects" }),
    ).rejects.toMatchObject({
      status: 307,
      options: {
        to: "/projects/$projectId/overview",
        params: { projectId: "project_one" },
      },
    });
  });

  it("repairs a direct Step 1 link by resuming the saved Website", async () => {
    fetchMock
      .mockResolvedValueOnce(accountResponse("owner"))
      .mockResolvedValueOnce(projectWebsitesResponse(pendingWebsite()));

    await expect(
      requireActivationAccess(
        {
          href: "/onboarding/project_one/website",
          pathname: "/onboarding/project_one/website",
        },
        "project_one",
      ),
    ).rejects.toMatchObject({
      status: 307,
      options: {
        to: "/onboarding/$projectId/install",
        search: { website: "website_ndle" },
      },
    });
  });

  it("allows Back to edit the exact unfinished Website", async () => {
    fetchMock
      .mockResolvedValueOnce(accountResponse("owner"))
      .mockResolvedValueOnce(projectWebsitesResponse(pendingWebsite()));

    await expect(
      requireActivationAccess(
        {
          href: "/onboarding/project_one/website?website=website_ndle",
          pathname: "/onboarding/project_one/website",
          search: { website: "website_ndle" },
        },
        "project_one",
      ),
    ).resolves.toBeUndefined();
  });

  it("does not let an unknown Website id bypass pending setup recovery", async () => {
    fetchMock
      .mockResolvedValueOnce(accountResponse("owner"))
      .mockResolvedValueOnce(projectWebsitesResponse(pendingWebsite()));

    await expect(
      requireActivationAccess(
        {
          href: "/onboarding/project_one/website?website=website_unknown",
          pathname: "/onboarding/project_one/website",
          search: { website: "website_unknown" },
        },
        "project_one",
      ),
    ).rejects.toMatchObject({
      status: 307,
      options: {
        to: "/onboarding/$projectId/install",
        search: { website: "website_ndle" },
      },
    });
  });

  it("keeps Step 1 available for adding another Website after activation", async () => {
    fetchMock
      .mockResolvedValueOnce(accountResponse("owner"))
      .mockResolvedValueOnce(projectWebsitesResponse(connectedWebsite()));

    await expect(
      requireActivationAccess(
        {
          href: "/onboarding/project_one/website",
          pathname: "/onboarding/project_one/website",
        },
        "project_one",
      ),
    ).resolves.toBeUndefined();
  });
});

function pendingWebsite() {
  return {
    id: "website_ndle",
    name: "ndle.app",
    origin: "https://ndle.app",
    firstEventAt: null,
  };
}

function connectedWebsite() {
  return { ...pendingWebsite(), firstEventAt: 1 };
}

function projectWebsitesResponse(
  ...websites: Array<{ id: string; name: string; origin: string; firstEventAt: number | null }>
): Response {
  return Response.json({ websites });
}

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
