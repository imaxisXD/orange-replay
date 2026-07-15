import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { clearDashboardAccess, signOutDashboardAccess } from "../src/lib/dashboard-access";

afterEach(() => clearDashboardAccess());

describe("hosted sign-out", () => {
  it("finishes only when Better Auth reports success", async () => {
    const signOut = vi.fn().mockResolvedValue({ data: null, error: null });

    await expect(signOutDashboardAccess({ signOut })).resolves.toBeUndefined();
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("rejects the error returned by Better Auth", async () => {
    const error = new Error("The session could not be cleared.");
    const signOut = vi.fn().mockResolvedValue({ data: null, error });

    await expect(signOutDashboardAccess({ signOut })).rejects.toBe(error);
  });
});
