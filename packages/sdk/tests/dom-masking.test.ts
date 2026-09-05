// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { captureDomMasking } from "../src/dom-masking.ts";
import { mergeRecorderProjectConfig } from "../src/project-config.ts";
import type { RecorderConfig } from "../src/types.ts";

const local: RecorderConfig = {
  key: "or_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ingestUrl: "https://ingest.test",
  projectRef: "project",
  sampleRate: 1,
  maskPolicyVersion: 0,
  capture: { heatmaps: false, console: false, network: false, canvas: false },
  maskTextSelector: ".local-private",
  allowUrlParams: [],
  flushMs: 15000,
};
const remote = {
  domMaskingVersion: 1 as const,
  sampleRate: 1,
  maskPolicyVersion: 3,
  version: 7,
  maskRules: [{ selector: ".remote-private", action: "mask" as const }],
  capture: { heatmaps: false, console: false, network: false, canvas: true },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("capture masking snapshot", () => {
  it("records merged effective rules without exposing their selectors", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const config = mergeRecorderProjectConfig(local, remote, document);
    const evidence = await captureDomMasking(config, local);
    expect(evidence).toMatchObject({
      inputs: "all",
      text: "selected",
      localRules: { text: true, block: false, ignore: false },
      remoteConfigVersion: 7,
      remoteMaskPolicyVersion: 3,
      canvas: true,
      rulesFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(evidence)).not.toContain("private");
    const changed = await captureDomMasking({ ...config, maskTextSelector: ".changed" }, local);
    expect(changed?.rulesFingerprint).not.toBe(evidence?.rulesFingerprint);
    expect(await captureDomMasking(local, local)).toBeUndefined();
  });

  it("bounds stalled hashing and leaves identity unknown", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", { subtle: { digest: () => new Promise(() => {}) } });
    const result = captureDomMasking({ ...local, domMaskingVersion: 1 }, local);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ inputs: "all", text: "selected" });
    expect((await result)?.rulesFingerprint).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
