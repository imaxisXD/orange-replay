// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import {
  isSafePrivacySelector,
  loadRecorderProjectConfig,
  mergeRecorderProjectConfig,
  parseRecorderProjectConfig,
} from "../src/project-config.ts";
import type { RecorderConfig } from "../src/types.ts";

const localConfig: RecorderConfig = {
  key: "or_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ingestUrl: "https://ingest.test",
  projectRef: "project",
  sampleRate: 0.8,
  maskPolicyVersion: 0,
  capture: { heatmaps: false, console: false, network: false, canvas: false },
  maskTextSelector: ".local-mask",
  blockSelector: ".local-block",
  allowUrlParams: [],
  flushMs: 15_000,
};

const remoteConfig = {
  sampleRate: 0.5,
  maskPolicyVersion: 3,
  maskRules: [
    { selector: ".remote-mask", action: "mask" as const },
    { selector: ".remote-block", action: "block" as const },
  ],
  capture: { heatmaps: true, console: false, network: false, canvas: true },
  version: 7,
};

describe("recorder project config", () => {
  it("merges dashboard sampling, masking, and capture settings", () => {
    expect(mergeRecorderProjectConfig(localConfig, remoteConfig, document)).toMatchObject({
      sampleRate: 0.5,
      maskPolicyVersion: 3,
      maskTextSelector: ".local-mask, .remote-mask",
      blockSelector: ".local-block, .remote-block",
      capture: remoteConfig.capture,
    });
  });

  it("never lets remote config increase the local sample rate", () => {
    expect(
      mergeRecorderProjectConfig(
        { ...localConfig, sampleRate: 0.1 },
        { ...remoteConfig, sampleRate: 1 },
        document,
      ).sampleRate,
    ).toBe(0.1);
  });

  it.each([
    ["block" as const, "["],
    ["mask" as const, ".private:hover"],
    ["block" as const, ".field:focus-within"],
    ["mask" as const, "input:checked"],
    ["block" as const, "input:dir(rtl)"],
    ["mask" as const, ".form:has(input:dir(rtl))"],
    ["mask" as const, "a:\\l\\i\\n\\k"],
    ["block" as const, ".private:has(a:\\l\\i\\n\\k)"],
  ])("stops recording when a remote %s selector is unsafe: %s", (action, selector) => {
    const merged = mergeRecorderProjectConfig(
      localConfig,
      {
        ...remoteConfig,
        maskRules: [{ selector, action }],
      },
      document,
    );

    expect(merged.sampleRate).toBe(0);
  });

  it.each([
    '[data-url="https://example.test/a:b"]',
    "[data\\-private]",
    ".field\\:name",
    "section > .private:nth-child(2)",
    "article:not(.public)",
    "ARTICLE:NOT(.public)",
  ])("accepts a stable privacy selector: %s", (selector) => {
    expect(isSafePrivacySelector(selector, document)).toBe(true);
  });

  it("checks selector syntax without searching the page DOM", () => {
    const pageQuery = vi.spyOn(document, "querySelector");

    expect(isSafePrivacySelector("main > .private:nth-child(2)", document)).toBe(true);
    expect(pageQuery).not.toHaveBeenCalled();
  });

  it("loads config using the public write key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(remoteConfig), {
        headers: { "content-type": "application/json" },
      }),
    );

    const loaded = await loadRecorderProjectConfig(localConfig, fetchMock, document);

    expect(loaded.sampleRate).toBe(0.5);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ingest.test/v1/config",
      expect.objectContaining({
        method: "GET",
        headers: { "x-or-key": localConfig.key },
        cache: "no-store",
        credentials: "omit",
      }),
    );
  });

  it("rejects incomplete server config", () => {
    expect(parseRecorderProjectConfig({ sampleRate: 1 })).toBeNull();
  });

  it("does not capture when the config service fails", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("busy", { status: 503 }));

    expect((await loadRecorderProjectConfig(localConfig, fetchMock, document)).sampleRate).toBe(0);
  });

  it("keeps local settings for an older Worker without the config route", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("missing", { status: 404 }));

    expect(await loadRecorderProjectConfig(localConfig, fetchMock, document)).toBe(localConfig);
  });
});
