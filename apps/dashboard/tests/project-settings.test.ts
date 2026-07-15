import { describe, expect, it } from "vite-plus/test";
import type { StoredProjectConfig } from "@orange-replay/shared/types";
import {
  addAllowedOrigin,
  cleanMaskRules,
  makeProjectSettingsDraft,
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
    expect(added).toMatchObject([{ selector: "", action: "mask" }]);
    const uiId = added[0]?.uiId;
    expect(uiId).toBeTruthy();

    const withSelector = updateMaskRules(added, {
      type: "setSelector",
      index: 0,
      selector: ".private",
    });
    expect(withSelector).toEqual([{ selector: ".private", action: "mask", uiId }]);

    const withAction = updateMaskRules(withSelector, {
      type: "setAction",
      index: 0,
      action: "block",
    });
    expect(withAction).toEqual([{ selector: ".private", action: "block", uiId }]);

    expect(updateMaskRules(withAction, { type: "remove", index: 0 })).toEqual([]);
  });

  it("caps rules at 200 and requires selectors", () => {
    const fullRules = Array.from({ length: maxMaskRules }, (_item, index) => ({
      selector: `.rule-${index}`,
      action: "mask" as const,
      uiId: `rule-${index}`,
    }));

    expect(updateMaskRules(fullRules, { type: "add" })).toHaveLength(maxMaskRules);
    expect(validateMaskRules([{ selector: " ", action: "mask" }])).toBe(
      "Each masking rule needs a selector.",
    );
    expect(validateMaskRules(fullRules)).toBeNull();
  });

  it("rejects selectors that are invalid or depend on changing browser state", () => {
    expect(validateMaskRules([{ selector: ".item >", action: "mask" }])).toBe(
      "Use a valid CSS selector.",
    );
    expect(validateMaskRules([{ selector: "button:hover", action: "block" }])).toBe(
      "Use selectors based on document structure, not changing states like :hover.",
    );
    expect(validateMaskRules([{ selector: ":has(.private)", action: "mask" }])).toBeNull();
  });

  it("keeps UI ids in the editor but removes them from the save payload", () => {
    const draft = makeProjectSettingsDraft(makeConfig());
    const updated = updateMaskRules(draft.maskRules, {
      type: "setSelector",
      index: 0,
      selector: " .updated ",
    });

    expect(updated[0]?.uiId).toBe(draft.maskRules[0]?.uiId);
    expect(cleanMaskRules(updated)).toEqual([{ selector: ".updated", action: "mask" }]);
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
  return makeProjectSettingsDraft(makeConfig());
}
