import { accountResponseSchema, projectCreateResponseSchema } from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import { authHeaders, setupApiTestWorkers, worker } from "./api-test-helpers.ts";

setupApiTestWorkers();

interface AnalyticsBootstrapReceipt {
  projectId: string;
  sourceSessionCount: number;
  sourceCutoffMs: number;
  requiredSequence: number;
  reportId: string;
  completedAt: number;
}

describe("hosted account bootstrap", () => {
  it("adds another empty project to a workspace the user manages", async () => {
    const accountResponse = await worker.fetch("/api/v1/account", { headers: authHeaders() });
    expect(accountResponse.status).toBe(200);
    const before = accountResponseSchema.parse(await accountResponse.json());
    const workspace = before.workspaces.find(
      (candidate) => candidate.id === before.activeWorkspaceId,
    );
    expect(workspace).toBeDefined();
    if (workspace === undefined) throw new Error("The test workspace is missing.");

    const response = await worker.fetch("/api/v1/projects", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const created = projectCreateResponseSchema.parse(await response.json());
    expect(created.project).toMatchObject({
      id: expect.stringMatching(/^project_[0-9a-f-]{36}$/),
      name: "Default project",
      role: "owner",
    });
    expect(
      created.account.workspaces.find((candidate) => candidate.id === workspace.id)?.projects,
    ).toHaveLength(workspace.projects.length + 1);

    const configResponse = await worker.fetch(`/api/v1/projects/${created.project.id}/config`, {
      headers: authHeaders(),
    });
    expect(configResponse.status).toBe(200);
    expect(await configResponse.json()).toMatchObject({ allowedOrigins: [], version: 1 });
    expect(await readAnalyticsBootstrapReceipt(created.project.id)).toMatchObject({
      projectId: created.project.id,
      sourceSessionCount: 0,
      requiredSequence: 0,
      reportId: "new-project-bootstrap:hosted-account",
    });
  });

  it("rejects invalid or unmanaged workspaces when adding a project", async () => {
    const invalid = await worker.fetch("/api/v1/projects", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "not a workspace" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_workspace" });

    const forbidden = await worker.fetch("/api/v1/projects", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace_someone_else" }),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
  });

  it("creates one personal workspace and never claims an existing workspace", async () => {
    const body = {
      userId: "hosted_user_1",
      name: "Sunny",
      email: "sunny@example.com",
      existingWorkspaceId: "existing_production_workspace",
    };

    const first = await worker.fetch("/__test/api/hosted/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);
    const firstAccount = accountResponseSchema.parse(await first.json());
    expect(firstAccount.workspaces).toHaveLength(1);
    expect(firstAccount.workspaces[0]).toMatchObject({
      id: expect.stringMatching(/^workspace_[a-f0-9]{20}$/),
      name: "Sunny's workspace",
      role: "owner",
      projects: [
        {
          id: expect.stringMatching(/^project_[a-f0-9]{20}$/),
          name: "Default project",
          role: "owner",
        },
      ],
    });
    expect(firstAccount.activeWorkspaceId).toBe(firstAccount.workspaces[0]?.id);
    expect(firstAccount.workspaces[0]?.id).not.toBe(body.existingWorkspaceId);

    const projectId = firstAccount.workspaces[0]?.projects[0]?.id;
    expect(projectId).toBeDefined();
    const firstReceipt = await readAnalyticsBootstrapReceipt(projectId ?? "");
    expect(firstReceipt).toMatchObject({
      projectId,
      sourceSessionCount: 0,
      requiredSequence: 0,
      reportId: "new-project-bootstrap:hosted-account",
    });
    expect(firstReceipt?.sourceCutoffMs).toBe(firstReceipt?.completedAt);
    expect(firstReceipt?.completedAt).toBeGreaterThan(0);

    const second = await worker.fetch("/__test/api/hosted/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstAccount);
    expect(await readAnalyticsBootstrapReceipt(projectId ?? "")).toEqual(firstReceipt);

    const stats = await worker.fetch("/__test/api/hosted/admin/stats");
    expect(stats.status).toBe(200);
    expect(await stats.json()).toMatchObject({
      users: expect.any(Number),
      newUsers: expect.any(Number),
      workspaces: expect.any(Number),
      projects: expect.any(Number),
      activeKeys: expect.any(Number),
    });

    const users = await worker.fetch("/__test/api/hosted/admin/users?search=sunny&limit=10");
    expect(users.status).toBe(200);
    expect(await users.json()).toMatchObject({
      users: [
        {
          id: body.userId,
          name: body.name,
          email: body.email,
          role: "user",
          banned: false,
          workspaceCount: 1,
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
    });
  });

  it("does not give a completion receipt to a project that already existed", async () => {
    const response = await worker.fetch("/__test/api/hosted/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "hosted_user_with_existing_project",
        name: "Existing",
        email: "existing@example.com",
        existingWorkspaceId: "existing_project_workspace",
        existingProjectForUser: true,
      }),
    });
    expect(response.status).toBe(200);

    const account = accountResponseSchema.parse(await response.json());
    expect(account.workspaces).toHaveLength(1);
    expect(account.workspaces[0]?.projects).toEqual([]);
    const workspaceId = account.workspaces[0]?.id ?? "";
    const existingProjectId = `project_${workspaceId.replace(/^workspace_/, "")}`;
    expect(await readAnalyticsBootstrapReceipt(existingProjectId)).toBeNull();
  });
});

async function readAnalyticsBootstrapReceipt(
  projectId: string,
): Promise<AnalyticsBootstrapReceipt | null> {
  const response = await worker.fetch(
    `/__test/api/hosted/analytics-bootstrap-receipt?projectId=${encodeURIComponent(projectId)}`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { receipt: AnalyticsBootstrapReceipt | null };
  return body.receipt;
}
