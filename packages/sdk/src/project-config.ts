import { HDR_KEY } from "@orange-replay/shared/constants";
import type { CaptureToggles, MaskRule, RecorderProjectConfig } from "@orange-replay/shared/types";
import type { RecorderConfig } from "./types.ts";

const CONFIG_TIMEOUT_MS = 2_000;
const MAX_MASK_RULES = 200;
const STABLE_PRIVACY_PSEUDO =
  /^(?:empty|first-(?:child|of-type)|has|is|lang|last-(?:child|of-type)|not|nth-(?:child|last-child|last-of-type|of-type)|only-(?:child|of-type)|root|scope|where)$/i;

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
  const selectors = validSelectors(remoteConfig.maskRules, document);
  if (selectors === null) return stopRecording(localConfig);

  return {
    ...localConfig,
    sampleRate: Math.min(localConfig.sampleRate, remoteConfig.sampleRate),
    maskPolicyVersion: remoteConfig.maskPolicyVersion,
    capture: { ...remoteConfig.capture },
    maskTextSelector: mergeSelectors(localConfig.maskTextSelector, selectors.mask),
    blockSelector: mergeSelectors(localConfig.blockSelector, selectors.block),
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

export function assertSafePrivacySelectors(config: RecorderConfig, document: Document): void {
  assertSafePrivacySelector("blockSelector", config.blockSelector, document);
  assertSafePrivacySelector("maskTextSelector", config.maskTextSelector, document);
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
  document: Document,
): Record<MaskRule["action"], string[]> | null {
  const selectors: Record<MaskRule["action"], string[]> = { mask: [], block: [] };
  for (const rule of rules) {
    if (!isSafePrivacySelector(rule.selector, document)) return null;
    selectors[rule.action].push(rule.selector);
  }
  return selectors;
}

/**
 * Privacy selectors must not depend on browser state that can change without a
 * DOM mutation. Structural pseudo-classes remain safe because the recorder
 * already observes their DOM changes.
 */
export function isSafePrivacySelector(selector: string, document: Document): boolean {
  const structuralSelector = selector
    .replace(
      /\[(?:\\.|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\]])*\]|\/\*[\s\S]*?\*\/|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g,
      "",
    )
    // Escapes outside strings and attributes cannot introduce a trusted
    // pseudo name. Replacing the full escape keeps escaped colons harmless
    // while making an escaped pseudo fail closed.
    .replace(/\\(?:[\da-f]{1,6}\s?|[\s\S])/gi, "_");
  for (const match of structuralSelector.matchAll(/(:{1,2})([\w-]+)/g)) {
    if (match[1] !== ":" || !STABLE_PRIVACY_PSEUDO.test(match[2]!)) return false;
  }

  try {
    // Parse against an empty root so validation never searches the customer's
    // DOM, even when the page is extremely large.
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

function assertSafePrivacySelector(
  configName: "blockSelector" | "maskTextSelector",
  selector: string | undefined,
  document: Document,
): void {
  if (selector !== undefined && !isSafePrivacySelector(selector, document)) {
    throw new Error(`${configName} must use a stable CSS selector.`);
  }
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
