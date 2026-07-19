import { describe, expect, it } from "vite-plus/test";
import { formatSessionCount } from "../src/lib/session-count";

describe("session count copy", () => {
  it("pluralizes correctly", () => {
    expect(formatSessionCount(0, false)).toBe("0 sessions");
    expect(formatSessionCount(1, false)).toBe("1 session");
    expect(formatSessionCount(2, false)).toBe("2 sessions");
  });

  it("marks a partially loaded list with a plus", () => {
    expect(formatSessionCount(25, true)).toBe("25+ sessions");
    expect(formatSessionCount(1, true)).toBe("1+ sessions");
  });
});
