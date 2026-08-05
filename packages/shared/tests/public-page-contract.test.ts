import { describe, expect, it } from "vite-plus/test";
import {
  demoWorkspaceResponseSchema,
  installStatusResponseSchema,
  publicPageDataSchema,
  publicPageSettingsSchema,
  publicPageSettingsUpdateSchema,
  type PublicPageData,
  type PublicPageSettings,
} from "../src/index.ts";

const sessionId = "session_0000000001";

describe("public page contracts", () => {
  it("accepts the complete anonymous page response", () => {
    expect(publicPageDataSchema.parse(publicPageData())).toEqual(publicPageData());
  });

  it("rejects unsafe analytics and ignores additive response fields", () => {
    expect(
      publicPageDataSchema.safeParse({
        ...publicPageData(),
        analytics: { ...publicPageData().analytics, ragePercent: 1.1 },
      }).success,
    ).toBe(false);
    expect(publicPageDataSchema.parse({ ...publicPageData(), futureField: true })).toEqual(
      publicPageData(),
    );
  });

  it("keeps public settings ids, URLs, and recordings consistent", () => {
    expect(publicPageSettingsSchema.safeParse(publicPageSettings()).success).toBe(true);
    expect(
      publicPageSettingsSchema.safeParse({
        ...publicPageSettings(),
        publicUrl: null,
      }).success,
    ).toBe(false);
    expect(
      publicPageSettingsSchema.safeParse({
        ...publicPageSettings(),
        recordings: [...publicPageSettings().recordings, ...publicPageSettings().recordings],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate or invalid public settings updates", () => {
    expect(
      publicPageSettingsUpdateSchema.safeParse({
        enabled: true,
        expectedRevision: 1,
        sessionIds: [sessionId, sessionId],
      }).success,
    ).toBe(false);
    expect(
      publicPageSettingsUpdateSchema.safeParse({
        enabled: true,
        expectedRevision: 1,
        sessionIds: ["bad/slash"],
      }).success,
    ).toBe(false);
  });

  it("requires exact install-status and demo discovery responses", () => {
    expect(installStatusResponseSchema.safeParse({ firstEventAt: null }).success).toBe(true);
    expect(installStatusResponseSchema.safeParse({}).success).toBe(false);
    expect(
      demoWorkspaceResponseSchema.safeParse({
        projectId: "demo_project",
        recorderKey: `or_live_${"a".repeat(32)}`,
      }).success,
    ).toBe(true);
    expect(
      demoWorkspaceResponseSchema.safeParse({
        projectId: "demo/project",
        recorderKey: "wrong",
      }).success,
    ).toBe(false);
  });
});

function publicPageData(): PublicPageData {
  return {
    version: 1,
    publicId: "pub_test",
    publicUrl: "https://public.example.com/p/pub_test",
    projectName: "Orange Replay",
    generatedAt: 1,
    analytics: {
      sessions: 1,
      averageDurationMs: 1_500,
      p50DurationMs: 1_000,
      clicks: 2,
      pagesPerSession: 1.5,
      pagesCoveredSessions: 1,
      ragePercent: 0.1,
      quickBackPercent: null,
      countries: [{ label: "US", count: 1, share: 1 }],
      devices: [],
      browsers: [],
      operatingSystems: [],
      entryPages: [],
    },
    recordings: [],
  };
}

function publicPageSettings(): PublicPageSettings {
  return {
    enabled: true,
    publicId: "pub_test",
    publicUrl: "https://public.example.com/p/pub_test",
    revision: 1,
    recordings: [
      {
        sessionId,
        replayId: "replay_test",
        position: 0,
        startedAt: 1,
        durationMs: 1_000,
        entryPath: "/home",
        country: "US",
        device: "Desktop",
        browser: "Chrome",
        operatingSystem: "macOS",
        clicks: 1,
        errors: 0,
        rages: 0,
        pages: 1,
      },
    ],
  };
}
