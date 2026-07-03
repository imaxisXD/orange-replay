import { describe, expect, it } from "vite-plus/test";
import { PACKAGE } from "../src/index.ts";

describe("@orange-replay/shared skeleton", () => {
  it("exports the package marker", () => {
    expect(PACKAGE).toBe("@orange-replay/shared");
  });
});
