// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { buildClickDetail, normalizedCoords, scrubUrl, truncateDetail } from "../src/scrub.ts";

describe("scrubUrl", () => {
  it("strips query strings and fragments by default", () => {
    expect(scrubUrl("https://example.com/path/to/page?token=secret#part")).toBe("/path/to/page");
  });

  it("keeps only allowlisted query params", () => {
    expect(scrubUrl("https://example.com/search?q=shoes&token=secret&page=2#part", ["q"])).toBe(
      "/search?q=shoes",
    );
  });
});

describe("details", () => {
  it("truncates long details", () => {
    expect(truncateDetail("a".repeat(250))).toHaveLength(200);
  });

  it("builds a short click selector from up to three ancestors", () => {
    document.body.innerHTML =
      '<main id="app"><section class="hero top"><button id="buy" class="primary large">Buy</button></section></main>';
    const button = document.querySelector("button");

    expect(buildClickDetail(button)).toBe("main#app > section.hero.top > button#buy.primary.large");
  });

  it("normalizes coordinates to the viewport", () => {
    expect(normalizedCoords({ clientX: 50, clientY: 25 }, { width: 200, height: 100 })).toEqual({
      x: 0.25,
      y: 0.25,
    });
  });
});
