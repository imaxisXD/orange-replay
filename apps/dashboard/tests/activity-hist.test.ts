import { describe, expect, it } from "vite-plus/test";
import { decodeActivityHist } from "../src/lib/activity-hist";

describe("activity histogram codec", () => {
  it("decodes levels and error buckets", () => {
    const decoded = decodeActivityHist("3a5f9c42-14");
    expect(decoded).not.toBeNull();
    expect(decoded?.levels).toEqual([3, 10, 5, 15, 9, 12, 4, 2]);
    // 0x14 = 0b00010100 -> buckets 2 and 4 carry errors
    expect(decoded?.errors).toEqual([false, false, true, false, true, false, false, false]);
  });

  it("decodes an all-quiet histogram", () => {
    const decoded = decodeActivityHist("00000000-00");
    expect(decoded?.levels).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(decoded?.errors.every((flag) => !flag)).toBe(true);
  });

  it("returns null for null, undefined, and malformed input", () => {
    expect(decodeActivityHist(null)).toBeNull();
    expect(decodeActivityHist(undefined)).toBeNull();
    expect(decodeActivityHist("")).toBeNull();
    expect(decodeActivityHist("3a5f9c42")).toBeNull();
    expect(decodeActivityHist("3a5f9c42-1")).toBeNull();
    expect(decodeActivityHist("3a5f9c42-zz")).toBeNull();
    expect(decodeActivityHist("3A5F9C42-14")).toBeNull();
    expect(decodeActivityHist("3a5f9c42-14x")).toBeNull();
  });
});
