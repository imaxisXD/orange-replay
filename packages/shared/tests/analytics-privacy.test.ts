import { safePublicEntryPath } from "@orange-replay/shared/analytics-privacy";
import { describe, expect, it } from "vite-plus/test";

describe("public entry path privacy", () => {
  it("keeps only the path from absolute and relative URLs", () => {
    expect(
      safePublicEntryPath(
        "https://private:secret@example.com/checkout/complete?email=private@example.com#token",
      ),
    ).toBe("/checkout/complete");
    expect(safePublicEntryPath("/pricing?plan=private#billing")).toBe("/pricing");
  });

  it("fails closed for missing, invalid, and non-HTTP values", () => {
    expect(safePublicEntryPath(null)).toBe("/");
    expect(safePublicEntryPath("")).toBe("/");
    expect(safePublicEntryPath("http://[")).toBe("/");
    expect(safePublicEntryPath("javascript:alert('private')")).toBe("/");
  });
});
