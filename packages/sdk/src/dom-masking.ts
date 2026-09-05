import type { AppliedDomMasking } from "@orange-replay/shared/types";
import type { RecorderConfig } from "./types.ts";

/** Snapshot once after local and remote selectors have been validated and merged. */
export async function captureDomMasking(
  config: RecorderConfig,
  local: RecorderConfig,
): Promise<AppliedDomMasking | undefined> {
  if (config.domMaskingVersion !== 1) return undefined;
  const policy: AppliedDomMasking = {
    v: 1,
    defaultsVersion: 1,
    inputs: "all",
    text: "selected",
    localRules: {
      text: Boolean(local.maskTextSelector),
      block: Boolean(local.blockSelector),
      ignore: Boolean(local.ignoreSelector),
    },
    remoteConfigVersion: config.configVersion,
    remoteMaskPolicyVersion: config.maskPolicyVersion,
    canvas: config.capture.canvas,
  };
  // Only the hash leaves the page. Missing hashing support keeps policy
  // identity unknown, and never disables an otherwise valid recording.
  const rules = [
    config.maskTextSelector ?? "",
    config.blockSelector ?? "",
    config.ignoreSelector ?? "",
  ];
  if (rules.reduce((length, rule) => length + rule.length, 0) > 64_000) return policy;
  let timeout: number | undefined;
  try {
    const digest = await Promise.race([
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([1, ...rules]))),
      new Promise<undefined>((resolve) => {
        timeout = window.setTimeout(() => resolve(undefined), 100);
      }),
    ]);
    if (digest !== undefined)
      policy.rulesFingerprint = new Uint8Array(digest).reduce(
        (hash, byte) => hash + byte.toString(16).padStart(2, "0"),
        "",
      );
  } catch {
    // Identity is optional; the capture settings above remain available.
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
  return policy;
}
