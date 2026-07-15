import { describe, expect, it } from "vite-plus/test";
import { stripRetiredLocalAuth } from "./scrub-retired-local-auth.mjs";

describe("retired local auth scrub", () => {
  it("removes only retired dashboard credential lines", () => {
    const result = stripRetiredLocalAuth(`DEV_API_TOKEN=secret
DEV_API_PROJECT_IDS=project_one
BETTER_AUTH_SECRET=keep-this
ORANGE_REPLAY_PROD_API_TOKEN=old-production-secret
DEMO_PROJECT_ID=demo
`);

    expect(result.removed).toEqual([
      "DEV_API_TOKEN",
      "DEV_API_PROJECT_IDS",
      "ORANGE_REPLAY_PROD_API_TOKEN",
    ]);
    expect(result.contents).toBe(`BETTER_AUTH_SECRET=keep-this
DEMO_PROJECT_ID=demo
`);
  });
});
