import { describe, expect, it, vi } from "vite-plus/test";
import { CheckpointSnapshotLimiter } from "../src/checkpoint.ts";

describe("checkpoint snapshots", () => {
  it("takes one full snapshot and throttles requests inside five seconds", () => {
    const takeFullSnapshot = vi.fn();
    let now = 1_000;
    const limiter = new CheckpointSnapshotLimiter({
      recorder: { takeFullSnapshot },
      now: () => now,
    });

    limiter.requestSnapshot();
    limiter.requestSnapshot();
    now += 4_999;
    limiter.requestSnapshot();
    now += 1;
    limiter.requestSnapshot();

    expect(takeFullSnapshot).toHaveBeenCalledTimes(2);
  });
});
