import { describe, expect, it } from "vite-plus/test";
import { dateRangeShorthand, formatSessionCount } from "../src/lib/session-count";

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

describe("date range shorthand", () => {
  const now = 1_783_600_000_000;
  const hour = 3_600_000;

  it("maps the overview picker buckets", () => {
    expect(dateRangeShorthand({ from: now - 24 * hour, to: now }, now)).toBe("24h");
    expect(dateRangeShorthand({ from: now - 3 * 24 * hour, to: now }, now)).toBe("3d");
    expect(dateRangeShorthand({ from: now - 7 * 24 * hour, to: now }, now)).toBe("7d");
    expect(dateRangeShorthand({ from: now - 28 * 24 * hour, to: now }, now)).toBe("28d");
  });

  it("defaults the open end to now", () => {
    expect(dateRangeShorthand({ from: now - 24 * hour }, now)).toBe("24h");
  });

  it("returns null without a lower bound or with an empty span", () => {
    expect(dateRangeShorthand({}, now)).toBeNull();
    expect(dateRangeShorthand({ to: now }, now)).toBeNull();
    expect(dateRangeShorthand({ from: now, to: now }, now)).toBeNull();
  });
});
