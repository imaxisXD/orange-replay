import * as v from "valibot";
import type { AppliedDomMasking, DomMasking, DomMaskingSummary } from "./types.ts";
import { sharedSchema } from "./validation.ts";

const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const appliedDomMaskingSchema = sharedSchema(
  v.strictObject({
    v: v.literal(1),
    defaultsVersion: v.literal(1),
    inputs: v.literal("all"),
    text: v.literal("selected"),
    localRules: v.strictObject({ text: v.boolean(), block: v.boolean(), ignore: v.boolean() }),
    remoteConfigVersion: v.optional(count),
    remoteMaskPolicyVersion: v.optional(count),
    rulesFingerprint: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
    canvas: v.boolean(),
  }),
);

export const domMaskingSchema = sharedSchema(
  v.strictObject({
    v: v.literal(1),
    policies: v.pipe(
      v.array(
        v.strictObject({ policy: appliedDomMaskingSchema, batches: v.pipe(count, v.minValue(1)) }),
      ),
      v.maxLength(32),
    ),
    unknownBatches: count,
    overflowBatches: count,
    canvasCaptured: v.optional(v.boolean()),
  }),
);

export const domMaskingSummarySchema = sharedSchema(
  v.strictObject({
    coverage: v.picklist(["complete", "partial", "unknown"]),
    policyCount: v.pipe(count, v.maxValue(32)),
    canvas: v.boolean(),
    inputs: v.optional(v.literal("all")),
    text: v.optional(v.literal("selected")),
  }),
);

/** Call only after a new batch is accepted, never when a duplicate is retried. */
export function addDomMaskingBatch(
  previous: DomMasking | undefined,
  policy: AppliedDomMasking | undefined,
  previousBatchCount: number,
): DomMasking {
  const summary: DomMasking =
    previous === undefined
      ? { v: 1, policies: [], unknownBatches: previousBatchCount, overflowBatches: 0 }
      : { ...previous, policies: previous.policies.map((item) => ({ ...item })) };
  const parsed = appliedDomMaskingSchema.safeParse(policy);
  if (!parsed.success) {
    summary.unknownBatches += 1;
    return summary;
  }
  const identity = JSON.stringify(parsed.data);
  summary.canvasCaptured ||= parsed.data.canvas;
  const existing = summary.policies.find((item) => JSON.stringify(item.policy) === identity);
  if (existing !== undefined) existing.batches += 1;
  else if (summary.policies.length < 32) summary.policies.push({ policy: parsed.data, batches: 1 });
  else summary.overflowBatches += 1;
  return summary;
}

export function summarizeDomMasking(summary: DomMasking | undefined): DomMaskingSummary {
  const policies = summary?.policies ?? [];
  const coverage =
    policies.length === 0
      ? "unknown"
      : summary!.unknownBatches > 0 ||
          summary!.overflowBatches > 0 ||
          policies.some((item) => item.policy.rulesFingerprint === undefined)
        ? "partial"
        : "complete";
  return {
    coverage,
    policyCount: policies.length,
    canvas: summary?.canvasCaptured === true || policies.some((item) => item.policy.canvas),
    ...(policies.length === 0 ? {} : { inputs: "all", text: "selected" }),
  };
}

export function domMaskingDescription(summary: DomMaskingSummary): string {
  if (summary.coverage === "unknown")
    return "This recording has no saved masking report. Its masking settings cannot be confirmed.";
  return [
    "The recorder reports input values masked and text masked by selected rules.",
    summary.policyCount > 1 ? "Masking settings differed across this recording." : "",
    summary.coverage === "partial" ? "Some masking details are unavailable." : "",
    summary.canvas ? "Canvas pixels were captured and are not covered by text masking." : "",
  ]
    .filter(Boolean)
    .join(" ");
}
