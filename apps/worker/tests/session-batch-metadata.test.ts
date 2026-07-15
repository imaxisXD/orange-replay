import { describe, expect, it } from "vite-plus/test";
import {
  encodeStoredBatchMetadata,
  parseStoredBatchMetadata,
} from "../src/do/session-batch-metadata.ts";

describe("stored replay batch metadata", () => {
  it("keeps the batch URL for ordered final analytics", () => {
    const encoded = encodeStoredBatchMetadata({
      u: "/checkout",
      e: [{ t: 1, k: "nav", d: "/checkout" }],
    });

    expect(parseStoredBatchMetadata(encoded)).toEqual({
      url: "/checkout",
      events: [{ t: 1, k: "nav", d: "/checkout" }],
      checkpointTimestamps: [],
      pageAnalyticsVersion: 1,
    });
  });

  it("still reads the compact legacy event array", () => {
    expect(parseStoredBatchMetadata('[{"t":1,"k":"click"}]')).toEqual({
      events: [{ t: 1, k: "click" }],
      checkpointTimestamps: [],
      pageAnalyticsVersion: 0,
    });
  });
});
