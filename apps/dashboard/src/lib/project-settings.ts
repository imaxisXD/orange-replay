import type {
  MaskRule,
  ProjectConfigUpdate,
  StoredProjectConfig,
} from "@orange-replay/shared/types";

export type ProjectSettingsDraft = Omit<ProjectConfigUpdate, "expectedVersion">;
export type MaskRuleActionValue = MaskRule["action"];

export const maxMaskRules = 200;
export const installStatusPollIntervalMs = 3_000;

export type MaskRulesEditorAction =
  | { type: "add" }
  | { type: "remove"; index: number }
  | { type: "setSelector"; index: number; selector: string }
  | { type: "setAction"; index: number; action: MaskRuleActionValue };

export function makeProjectSettingsDraft(config: StoredProjectConfig): ProjectSettingsDraft {
  return {
    sampleRate: config.sampleRate,
    retentionDays: config.retentionDays,
    allowedOrigins: [...config.allowedOrigins],
    maskPolicyVersion: config.maskPolicyVersion,
    maskRules: config.maskRules.map((rule) => ({ ...rule })),
    capture: { ...config.capture },
  };
}

export function updateMaskRules(
  rules: readonly MaskRule[],
  action: MaskRulesEditorAction,
): MaskRule[] {
  switch (action.type) {
    case "add":
      if (rules.length >= maxMaskRules) return [...rules];
      return [...rules, { selector: "", action: "mask" }];
    case "remove":
      return rules.filter((_rule, index) => index !== action.index);
    case "setSelector":
      return rules.map((rule, index) =>
        index === action.index ? { ...rule, selector: action.selector } : rule,
      );
    case "setAction":
      return rules.map((rule, index) =>
        index === action.index ? { ...rule, action: action.action } : rule,
      );
  }
}

export function validateMaskRules(rules: readonly MaskRule[]): string | null {
  if (rules.length > maxMaskRules) {
    return "You can add up to 200 masking rules.";
  }

  if (rules.some((rule) => rule.selector.trim().length === 0)) {
    return "Each masking rule needs a selector.";
  }

  return null;
}

export function cleanMaskRules(rules: readonly MaskRule[]): MaskRule[] {
  return rules.map((rule) => ({
    selector: rule.selector.trim(),
    action: rule.action,
  }));
}

export function sampleRateToPercentInput(sampleRate: number): string {
  const percent = clamp(sampleRate, 0, 1) * 100;
  return Number.isInteger(percent) ? String(percent) : trimTrailingZero(percent.toFixed(1));
}

export function percentInputToSampleRate(value: string): number | null {
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return percent / 100;
}

export function retentionInputToDays(value: string): number | null {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 365) return null;
  return days;
}

export function normalizeOriginInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "*") return "*";

  try {
    const url = new URL(trimmed);
    const isHttpOrigin = url.protocol === "http:" || url.protocol === "https:";
    const hasOnlyOrigin =
      url.username.length === 0 &&
      url.password.length === 0 &&
      (url.pathname === "" || url.pathname === "/") &&
      url.search.length === 0 &&
      url.hash.length === 0;

    return isHttpOrigin && hasOnlyOrigin ? url.origin : null;
  } catch {
    return null;
  }
}

export function addAllowedOrigin(
  origins: readonly string[],
  input: string,
): { origins: string[]; error: string | null } {
  const origin = normalizeOriginInput(input);
  if (origin === null) {
    return { origins: [...origins], error: "Enter * or a valid http:// or https:// origin." };
  }

  if (origins.includes(origin)) {
    return { origins: [...origins], error: null };
  }

  return { origins: [...origins, origin], error: null };
}

export function removeAllowedOrigin(origins: readonly string[], origin: string): string[] {
  if (origins.length <= 1) {
    return [...origins];
  }
  return origins.filter((currentOrigin) => currentOrigin !== origin);
}

export function projectSettingsAreDirty(
  savedConfig: StoredProjectConfig,
  draft: ProjectSettingsDraft,
): boolean {
  return !draftsMatch(makeProjectSettingsDraft(savedConfig), draft);
}

export function shouldPollInstallStatus(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState !== "hidden";
}

function draftsMatch(left: ProjectSettingsDraft, right: ProjectSettingsDraft): boolean {
  return JSON.stringify(stableDraft(left)) === JSON.stringify(stableDraft(right));
}

function stableDraft(draft: ProjectSettingsDraft): ProjectSettingsDraft {
  return {
    sampleRate: draft.sampleRate,
    retentionDays: draft.retentionDays,
    allowedOrigins: [...draft.allowedOrigins],
    maskPolicyVersion: draft.maskPolicyVersion,
    maskRules: draft.maskRules.map((rule) => ({
      selector: rule.selector,
      action: rule.action,
    })),
    capture: {
      heatmaps: draft.capture.heatmaps,
      console: draft.capture.console,
      network: draft.capture.network,
      canvas: draft.capture.canvas,
    },
  };
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
