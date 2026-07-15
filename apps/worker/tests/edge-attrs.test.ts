import { describe, expect, it } from "vite-plus/test";
import { attrsFromRequest } from "../src/ingest/edge-attrs.ts";

describe("user-agent attributes", () => {
  it.each([
    [
      "iPhone",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      "iOS",
      "mobile",
    ],
    [
      "iPad",
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      "iOS",
      "tablet",
    ],
    [
      "iPadOS desktop mode",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      "iOS",
      "tablet",
    ],
    [
      "Android phone",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/122.0 Mobile Safari/537.36",
      "Android",
      "mobile",
    ],
    [
      "Android tablet",
      "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/122.0 Safari/537.36",
      "Android",
      "tablet",
    ],
    [
      "Mac",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 Version/17.3 Safari/605.1.15",
      "macOS",
      "desktop",
    ],
  ])("classifies %s", (_name, userAgent, os, device) => {
    const attrs = attrsFromRequest(
      new Request("https://replay.test/v1/ingest", { headers: { "user-agent": userAgent } }),
    );

    expect(attrs).toMatchObject({ os, device });
  });
});
