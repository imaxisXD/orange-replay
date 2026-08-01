import type {
  MaskRule,
  ProjectConfigUpdate,
  StoredProjectConfig,
} from "@orange-replay/shared/types";
import {
  allowedOriginSchema,
  projectConfigUpdateMaskRulesSchema,
  projectConfigUpdateSchema,
  projectSampleRateSchema,
} from "@orange-replay/shared/project-config-update";

export interface DraftMaskRule extends MaskRule {
  uiId: string;
}

export type ProjectSettingsDraft = Omit<ProjectConfigUpdate, "expectedVersion" | "maskRules"> & {
  maskRules: DraftMaskRule[];
};
export type MaskRuleActionValue = MaskRule["action"];

export interface ProjectSettingsValidationErrors {
  capture: string;
  masking: string;
  origins: string;
}

export type ParsedProjectSettingsDraft =
  | { ok: true; update: ProjectConfigUpdate; errors: ProjectSettingsValidationErrors }
  | { ok: false; errors: ProjectSettingsValidationErrors };

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
    maskRules: config.maskRules.map((rule, index) => ({
      ...rule,
      uiId: `saved-mask-rule-${config.projectId}-${config.version}-${index}`,
    })),
    capture: { ...config.capture },
  };
}

export function updateMaskRules(
  rules: readonly DraftMaskRule[],
  action: MaskRulesEditorAction,
): DraftMaskRule[] {
  switch (action.type) {
    case "add":
      if (rules.length >= maxMaskRules) return [...rules];
      return [...rules, { selector: "", action: "mask", uiId: nextMaskRuleUiId() }];
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
  const parsed = projectConfigUpdateMaskRulesSchema.safeParse(
    rules.map(({ selector, action }) => ({ selector, action })),
  );
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the masking rules.");
}

export function sampleRateToPercentInput(sampleRate: number): string {
  const percent = clamp(sampleRate, 0, 1) * 100;
  return Number.isInteger(percent) ? String(percent) : trimTrailingZero(percent.toFixed(1));
}

export function percentInputToSampleRate(value: string): number | null {
  const percent = Number(value);
  const parsed = projectSampleRateSchema.safeParse(percent / 100);
  return parsed.success ? parsed.data : null;
}

export function normalizeOriginInput(value: string): string | null {
  const parsed = allowedOriginSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseProjectSettingsDraft(
  draft: ProjectSettingsDraft,
  expectedVersion: number,
): ParsedProjectSettingsDraft {
  const parsed = projectConfigUpdateSchema.safeParse({
    expectedVersion,
    sampleRate: draft.sampleRate,
    retentionDays: draft.retentionDays,
    allowedOrigins: draft.allowedOrigins,
    maskPolicyVersion: draft.maskPolicyVersion,
    maskRules: draft.maskRules.map(({ selector, action }) => ({ selector, action })),
    capture: draft.capture,
  });
  const errors: ProjectSettingsValidationErrors = { capture: "", masking: "", origins: "" };
  if (parsed.success) return { ok: true, update: parsed.data, errors };

  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === "allowedOrigins" && errors.origins.length === 0) errors.origins = issue.message;
    else if (field === "maskRules" && errors.masking.length === 0) errors.masking = issue.message;
    else if (errors.capture.length === 0) errors.capture = issue.message;
  }
  return { ok: false, errors };
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

function stableDraft(draft: ProjectSettingsDraft) {
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

let nextNewMaskRuleId = 0;

function nextMaskRuleUiId(): string {
  nextNewMaskRuleId += 1;
  return `new-mask-rule-${nextNewMaskRuleId}`;
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
