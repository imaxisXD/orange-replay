// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { hashToUnit, shouldSampleSession } from "../src/sampling.ts";

describe("sampling", () => {
  it("makes the same decision for the same session id", () => {
    const first = shouldSampleSession("018f6f7a-7f83-7000-9000-111111111111", 0.35);
    const second = shouldSampleSession("018f6f7a-7f83-7000-9000-111111111111", 0.35);

    expect(second).toBe(first);
  });

  it("maps a session id into the expected unit interval", () => {
    const value = hashToUnit("session");

    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  });

  it("honors hard off and hard on sample rates", () => {
    expect(shouldSampleSession("session", 0)).toBe(false);
    expect(shouldSampleSession("session", 1)).toBe(true);
  });
});
