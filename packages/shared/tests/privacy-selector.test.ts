import { describe, expect, it } from "vite-plus/test";
import {
  isStablePrivacySelector,
  readStablePrivacySelectorError,
} from "../src/privacy-selector.ts";
import { projectConfigUpdateSchema } from "../src/project-config-update.ts";

describe("stable privacy selectors", () => {
  it.each([
    ".checkout [data-private]",
    "form:has(input):not(.public)",
    "li:nth-child(2n + 1)",
    ':is([data-value=":hover"], .private)',
    ".literal\\:hover",
  ])("accepts structural selector %s", (selector) => {
    expect(isStablePrivacySelector(selector)).toBe(true);
  });

  it.each(["[", ".item >", "a,,b", ":not("])("rejects invalid selector %s", (selector) => {
    expect(readStablePrivacySelectorError(selector)).toBe("Use a valid CSS selector.");
  });

  it.each([
    ":hover",
    "input:checked",
    ".field:focus-within",
    ":dir(rtl)",
    ":has(button:hover)",
    "input::placeholder",
  ])("rejects stateful selector %s", (selector) => {
    expect(isStablePrivacySelector(selector)).toBe(false);
  });

  it("normalizes and validates selectors at the project update boundary", () => {
    const baseUpdate = {
      expectedVersion: 1,
      sampleRate: 1,
      retentionDays: 30,
      allowedOrigins: ["*"],
      maskPolicyVersion: 99,
      capture: { heatmaps: false, console: false, network: false, canvas: false },
    };

    const parsed = projectConfigUpdateSchema.parse({
      ...baseUpdate,
      maskRules: [{ selector: "  .private  ", action: "mask" }],
    });
    expect(parsed.maskRules).toEqual([{ selector: ".private", action: "mask" }]);

    expect(
      projectConfigUpdateSchema.safeParse({
        ...baseUpdate,
        maskRules: [{ selector: "button:hover", action: "block" }],
      }).success,
    ).toBe(false);
  });
});
