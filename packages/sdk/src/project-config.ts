import { HDR_KEY } from "@orange-replay/shared/constants";
import type { CaptureToggles, MaskRule, RecorderProjectConfig } from "@orange-replay/shared/types";
import type { RecorderConfig } from "./types.ts";

const CONFIG_TIMEOUT_MS = 2_000;
const MAX_MASK_RULES = 200;

export async function loadRecorderProjectConfig(
  localConfig: RecorderConfig,
  fetchFn: typeof fetch,
  document: Document,
): Promise<RecorderConfig> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);

  try {
    const response = await fetchFn(`${localConfig.ingestUrl}/v1/config`, {
      method: "GET",
      headers: { [HDR_KEY]: localConfig.key },
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    if (response.status === 404) return localConfig;
    if (!response.ok) return stopRecording(localConfig);

    const remoteConfig = parseRecorderProjectConfig(await response.json());
    return remoteConfig === null
      ? stopRecording(localConfig)
      : mergeRecorderProjectConfig(localConfig, remoteConfig, document);
  } catch {
    return stopRecording(localConfig);
  } finally {
    clearTimeout(timeout);
  }
}

function stopRecording(localConfig: RecorderConfig): RecorderConfig {
  return { ...localConfig, sampleRate: 0 };
}

export function mergeRecorderProjectConfig(
  localConfig: RecorderConfig,
  remoteConfig: RecorderProjectConfig,
  document: Document,
): RecorderConfig {
  const maskSelectors = validSelectors(remoteConfig.maskRules, "mask", document);
  const blockSelectors = validSelectors(remoteConfig.maskRules, "block", document);

  return {
    ...localConfig,
    sampleRate: Math.min(localConfig.sampleRate, remoteConfig.sampleRate),
    maskPolicyVersion: remoteConfig.maskPolicyVersion,
    capture: { ...remoteConfig.capture },
    maskTextSelector: mergeSelectors(localConfig.maskTextSelector, maskSelectors),
    blockSelector: mergeSelectors(localConfig.blockSelector, blockSelectors),
  };
}

export function parseRecorderProjectConfig(value: unknown): RecorderProjectConfig | null {
  if (!isRecord(value)) return null;

  const sampleRate = value["sampleRate"];
  const maskPolicyVersion = value["maskPolicyVersion"];
  const version = value["version"];
  const maskRules = parseMaskRules(value["maskRules"]);
  const capture = parseCapture(value["capture"]);
  if (
    typeof sampleRate !== "number" ||
    !Number.isFinite(sampleRate) ||
    sampleRate < 0 ||
    sampleRate > 1 ||
    !isNonNegativeInteger(maskPolicyVersion) ||
    !isNonNegativeInteger(version) ||
    maskRules === null ||
    capture === null
  ) {
    return null;
  }

  return { sampleRate, maskPolicyVersion, maskRules, capture, version };
}

function parseMaskRules(value: unknown): MaskRule[] | null {
  if (!Array.isArray(value) || value.length > MAX_MASK_RULES) return null;

  const rules: MaskRule[] = [];
  for (const rule of value) {
    if (!isRecord(rule)) return null;
    const selector = rule["selector"];
    const action = rule["action"];
    if (
      typeof selector !== "string" ||
      selector.length === 0 ||
      selector.length > 500 ||
      (action !== "mask" && action !== "block")
    ) {
      return null;
    }
    rules.push({ selector, action });
  }
  return rules;
}

function parseCapture(value: unknown): CaptureToggles | null {
  if (!isRecord(value)) return null;
  const heatmaps = value["heatmaps"];
  const consoleCapture = value["console"];
  const network = value["network"];
  const canvas = value["canvas"];
  return typeof heatmaps === "boolean" &&
    typeof consoleCapture === "boolean" &&
    typeof network === "boolean" &&
    typeof canvas === "boolean"
    ? { heatmaps, console: consoleCapture, network, canvas }
    : null;
}

function validSelectors(
  rules: readonly MaskRule[],
  action: MaskRule["action"],
  document: Document,
): string[] {
  return rules.flatMap((rule) => {
    if (rule.action !== action) return [];
    try {
      document.querySelector(rule.selector);
      return [rule.selector];
    } catch {
      return [];
    }
  });
}

function mergeSelectors(local: string | undefined, remote: readonly string[]): string | undefined {
  const selectors = [...(local === undefined ? [] : [local]), ...remote];
  return selectors.length === 0 ? undefined : selectors.join(", ");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
