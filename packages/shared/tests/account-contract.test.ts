import { describe, expect, it } from "vite-plus/test";
import { adminStatsResponseSchema, adminUsersResponseSchema } from "../src/index.ts";

describe("admin response contracts", () => {
  it("accepts complete stats and user pages", () => {
    expect(
      adminStatsResponseSchema.safeParse({
        users: 2,
        newUsers: 1,
        workspaces: 1,
        projects: 3,
        activeKeys: 2,
      }).success,
    ).toBe(true);
    expect(
      adminUsersResponseSchema.safeParse({
        users: [
          {
            id: "user_1",
            name: "Sunny",
            email: "sunny@example.com",
            image: null,
            role: "admin",
            banned: false,
            banReason: null,
            createdAt: 1,
            lastSignedInAt: null,
            workspaceCount: 1,
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects incomplete stats and malformed user rows", () => {
    expect(adminStatsResponseSchema.safeParse({ users: 2 }).success).toBe(false);
    expect(
      adminUsersResponseSchema.safeParse({
        users: [{ id: "user_1" }],
        total: 1,
        limit: 25,
        offset: 0,
      }).success,
    ).toBe(false);
  });
});
