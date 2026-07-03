import { describe, expect, it } from "vite-plus/test";
import {
  expiresAtFromEndedAt,
  truncateEventDetail,
  usageMonthFromStartedAt,
} from "../src/consumer/helpers.ts";

describe("consumer helper logic", () => {
  it("derives the usage month from the session start time", () => {
    const startedAt = Date.UTC(2026, 0, 31, 23, 59, 59);

    expect(usageMonthFromStartedAt(startedAt)).toBe("2026-01");
  });

  it("truncates event detail to 200 characters", () => {
    const detail = "a".repeat(250);

    expect(truncateEventDetail(detail)).toHaveLength(200);
    expect(truncateEventDetail(undefined)).toBeNull();
  });

  it("derives the expiry time from ended_at and retention days", () => {
    const endedAt = Date.UTC(2026, 5, 1, 12, 0, 0);

    expect(expiresAtFromEndedAt(endedAt, 7)).toBe(endedAt + 7 * 86_400_000);
  });
});
