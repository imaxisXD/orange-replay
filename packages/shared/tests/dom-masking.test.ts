import { describe, expect, it } from "vite-plus/test";
import {
  addDomMaskingBatch,
  domMaskingDescription,
  summarizeDomMasking,
} from "../src/dom-masking.ts";
import { batchIndexSchema } from "../src/schemas.ts";
import type { AppliedDomMasking } from "../src/types.ts";

const policy: AppliedDomMasking = {
  v: 1,
  defaultsVersion: 1,
  inputs: "all",
  text: "selected",
  localRules: { text: true, block: false, ignore: false },
  rulesFingerprint: "a".repeat(64),
  canvas: false,
};

describe("recorded masking evidence", () => {
  it("counts old batches as unknown and keeps changed policies separate", () => {
    const first = addDomMaskingBatch(undefined, policy, 2);
    const same = addDomMaskingBatch(first, policy, 3);
    const changed = addDomMaskingBatch(
      same,
      { ...policy, rulesFingerprint: "b".repeat(64), canvas: true },
      4,
    );
    expect(first.policies[0]?.batches).toBe(1);
    expect(changed.policies.map((item) => item.batches)).toEqual([2, 1]);
    expect(summarizeDomMasking(changed)).toEqual({
      coverage: "partial",
      policyCount: 2,
      canvas: true,
      inputs: "all",
      text: "selected",
    });
    expect(domMaskingDescription(summarizeDomMasking(changed))).toContain(
      "Canvas pixels were captured",
    );
    expect(domMaskingDescription(summarizeDomMasking(undefined))).toBe(
      "This recording has no saved masking report. Its masking settings cannot be confirmed.",
    );
  });

  it("bounds policy storage while retaining canvas evidence from overflow", () => {
    let summary = addDomMaskingBatch(undefined, policy, 0);
    for (let index = 1; index < 34; index++)
      summary = addDomMaskingBatch(
        summary,
        { ...policy, remoteConfigVersion: index, canvas: index === 33 },
        index,
      );
    expect(summary.policies).toHaveLength(32);
    expect(summary.overflowBatches).toBe(2);
    expect(summarizeDomMasking(summary)).toMatchObject({ coverage: "partial", canvas: true });
  });

  it("does not lose a valid replay batch because optional evidence is malformed", () => {
    const index = { v: 1, s: "session", tab: "tab", seq: 0, t0: 1, t1: 2, e: [] };
    expect(
      batchIndexSchema.parse({
        ...index,
        appliedDomMasking: { ...policy, selector: "private-selector" },
      }).appliedDomMasking,
    ).toBeUndefined();
    expect(
      batchIndexSchema.parse({ ...index, appliedDomMasking: policy }).appliedDomMasking,
    ).toEqual(policy);
  });
});
