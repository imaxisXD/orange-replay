import { describe, expect, it } from "vite-plus/test";
import type { StoredProjectConfig } from "@orange-replay/shared/types";
import {
  addAllowedOrigin,
  maxMaskRules,
  normalizeOriginInput,
  percentInputToSampleRate,
  projectSettingsAreDirty,
  removeAllowedOrigin,
  sampleRateToPercentInput,
  shouldPollInstallStatus,
  updateMaskRules,
  validateMaskRules,
} from "../src/lib/project-settings";

describe("masking rule editor", () => {
  it("adds, edits, and removes rules", () => {
    const added = updateMaskRules([], { type: "add" });
    expect(added).toEqual([{ selector: "", action: "mask" }]);

    const withSelector = updateMaskRules(added, {
      type: "setSelector",
      index: 0,
      selector: ".private",
    });
    expect(withSelector).toEqual([{ selector: ".private", action: "mask" }]);

    const withAction = updateMaskRules(withSelector, {
      type: "setAction",
      index: 0,
      action: "block",
    });
    expect(withAction).toEqual([{ selector: ".private", action: "block" }]);

    expect(updateMaskRules(withAction, { type: "remove", index: 0 })).toEqual([]);
  });

  it("caps rules at 200 and requires selectors", () => {
    const fullRules = Array.from({ length: maxMaskRules }, (_item, index) => ({
      selector: `.rule-${index}`,
      action: "mask" as const,
    }));

    expect(updateMaskRules(fullRules, { type: "add" })).toHaveLength(maxMaskRules);
    expect(validateMaskRules([{ selector: " ", action: "mask" }])).toBe(
      "Each masking rule needs a selector.",
    );
    expect(validateMaskRules(fullRules)).toBeNull();
  });
});

describe("origin validation", () => {
  it("accepts wildcard and http origins only", () => {
    expect(normalizeOriginInput("*")).toBe("*");
    expect(normalizeOriginInput(" https://app.example.com/ ")).toBe("https://app.example.com");
    expect(normalizeOriginInput("http://localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeOriginInput("ftp://app.example.com")).toBeNull();
    expect(normalizeOriginInput("https://app.example.com/path")).toBeNull();
  });

  it("adds valid origins without duplicates", () => {
    expect(addAllowedOrigin(["*"], "https://app.example.com").origins).toEqual([
      "*",
      "https://app.example.com",
    ]);
    expect(addAllowedOrigin(["https://app.example.com"], "https://app.example.com/")).toEqual({
      origins: ["https://app.example.com"],
      error: null,
    });
    expect(addAllowedOrigin([], "not an origin").error).toBe(
      "Enter * or a valid http:// or https:// origin.",
    );
  });

  it("keeps at least one allowed origin", () => {
    expect(removeAllowedOrigin(["https://app.example"], "https://app.example")).toEqual([
      "https://app.example",
    ]);
    expect(removeAllowedOrigin(["*", "https://app.example"], "*")).toEqual(["https://app.example"]);
  });
});

describe("sample-rate mapping", () => {
  it("maps percent input to the stored fraction and back", () => {
    expect(sampleRateToPercentInput(0.25)).toBe("25");
    expect(sampleRateToPercentInput(0.255)).toBe("25.5");
    expect(percentInputToSampleRate("25")).toBe(0.25);
    expect(percentInputToSampleRate("100")).toBe(1);
    expect(percentInputToSampleRate("101")).toBeNull();
  });
});

describe("settings dirty state", () => {
  it("detects changed draft values", () => {
    const saved = makeConfig();
    expect(projectSettingsAreDirty(saved, makeDraft())).toBe(false);
    expect(
      projectSettingsAreDirty(saved, {
        ...makeDraft(),
        retentionDays: 45,
      }),
    ).toBe(true);
  });
});

describe("install status polling", () => {
  it("polls only while visible", () => {
    expect(shouldPollInstallStatus("visible")).toBe(true);
    expect(shouldPollInstallStatus("hidden")).toBe(false);
  });
});

function makeConfig(): StoredProjectConfig {
  return {
    projectId: "p1",
    orgId: "o1",
    shard: 0,
    active: true,
    sampleRate: 0.25,
    retentionDays: 30,
    allowedOrigins: ["*"],
    maskPolicyVersion: 1,
    maskRules: [{ selector: ".secret", action: "mask" }],
    capture: {
      heatmaps: false,
      console: false,
      network: true,
      canvas: false,
    },
    quotaState: "ok",
    version: 1,
  };
}

function makeDraft() {
  return {
    sampleRate: 0.25,
    retentionDays: 30,
    allowedOrigins: ["*"],
    maskPolicyVersion: 1,
    maskRules: [{ selector: ".secret", action: "mask" as const }],
    capture: {
      heatmaps: false,
      console: false,
      network: true,
      canvas: false,
    },
  };
}
