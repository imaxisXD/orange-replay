import { describe, expect, it } from "vite-plus/test";
import {
  readAnalyticsDeletionReadVersion,
  requireDistinctAnalyticsStreamIds,
} from "./analytics/deletion-v2-config.mjs";

describe("analytics deletion v2 production config", () => {
  it("keeps v1 as the safe default and accepts only an explicit v2 cutover", () => {
    expect(readAnalyticsDeletionReadVersion({})).toBe("v1");
    expect(
      readAnalyticsDeletionReadVersion({
        ORANGE_REPLAY_PROD_ANALYTICS_DELETION_READ_VERSION: "v2",
      }),
    ).toBe("v2");
    expect(() =>
      readAnalyticsDeletionReadVersion({
        ORANGE_REPLAY_PROD_ANALYTICS_DELETION_READ_VERSION: "v3",
      }),
    ).toThrow("must be v1 or v2");
  });

  it("rejects reusing the v1 structured stream for v2 deletions", () => {
    expect(() => requireDistinctAnalyticsStreamIds("primary-stream", "primary-stream")).toThrow(
      "must be different",
    );
    expect(() =>
      requireDistinctAnalyticsStreamIds("primary-stream", "deletion-v2-stream"),
    ).not.toThrow();
  });
});
