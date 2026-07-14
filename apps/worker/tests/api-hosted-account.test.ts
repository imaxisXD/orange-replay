import { describe, expect, it } from "vite-plus/test";
import type { AccountResponse } from "../src/api/account-routes.ts";
import { setupApiTestWorkers, worker } from "./api-test-helpers.ts";

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
    const firstAccount = (await first.json()) as AccountResponse;
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

    const account = (await response.json()) as AccountResponse;
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
