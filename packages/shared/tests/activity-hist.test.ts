import { describe, expect, it } from "vite-plus/test";
import {
  ActivityHistAccumulator,
  decodeActivityHist,
  encodeActivityHist,
} from "../src/activity-hist.ts";

describe("encodeActivityHist", () => {
  it("max-normalizes counts to 0-15 and encodes the error mask", () => {
    const encoded = encodeActivityHist(
      [0, 15, 30, 0, 0, 0, 0, 0],
      [false, false, true, false, false, false, false, false],
    );
    expect(encoded).toBe("08f00000-04");
  });

  it("never rounds a non-empty bucket down to zero", () => {
    const encoded = encodeActivityHist(
      [1, 1000, 0, 0, 0, 0, 0, 0],
      [false, false, false, false, false, false, false, false],
    );
    expect(encoded?.[0]).toBe("1");
  });

  it("returns null for an empty session or wrong arity", () => {
    expect(
      encodeActivityHist(
        [0, 0, 0, 0, 0, 0, 0, 0],
        Array.from({ length: 8 }, () => false),
      ),
    ).toBeNull();
    expect(encodeActivityHist([1, 2, 3], [false, false, false])).toBeNull();
  });

  it("round-trips through decode", () => {
    const encoded = encodeActivityHist(
      [3, 9, 1, 15, 6, 0, 2, 4],
      [true, false, false, false, true, false, false, false],
    );
    expect(encoded).not.toBeNull();
    const decoded = decodeActivityHist(encoded);
    expect(decoded?.levels).toHaveLength(8);
    expect(decoded?.errors[0]).toBe(true);
    expect(decoded?.errors[4]).toBe(true);
    expect(decoded?.errors[1]).toBe(false);
  });
});

describe("ActivityHistAccumulator", () => {
  it("buckets events across the session span and flags error buckets", () => {
    const accumulator = new ActivityHistAccumulator(1_000, 9_000);
    // bucket width = 1000ms; bucket 0 gets 2 events, bucket 4 an error, last bucket 1 event
    accumulator.add(1_100, "click");
    accumulator.add(1_900, "scroll");
    accumulator.add(5_500, "error");
    accumulator.add(8_999, "nav");
    const decoded = decodeActivityHist(accumulator.finish());
    expect(decoded).not.toBeNull();
    expect(decoded?.levels[0]).toBe(15);
    expect(decoded?.errors[4]).toBe(true);
    expect(decoded?.levels[7]).toBeGreaterThan(0);
    expect(decoded?.levels[2]).toBe(0);
  });

  it("clamps out-of-range timestamps into the edge buckets", () => {
    const accumulator = new ActivityHistAccumulator(1_000, 2_000);
    accumulator.add(0, "click");
    accumulator.add(99_999, "error");
    accumulator.add(Number.NaN, "click");
    const decoded = decodeActivityHist(accumulator.finish());
    expect(decoded?.levels[0]).toBeGreaterThan(0);
    expect(decoded?.levels[7]).toBeGreaterThan(0);
    expect(decoded?.errors[7]).toBe(true);
  });

  it("handles a degenerate zero-length span", () => {
    const accumulator = new ActivityHistAccumulator(1_000, 1_000);
    accumulator.add(1_000, "click");
    expect(accumulator.finish()).not.toBeNull();
  });

  it("returns null with no events", () => {
    expect(new ActivityHistAccumulator(0, 1_000).finish()).toBeNull();
  });
});
