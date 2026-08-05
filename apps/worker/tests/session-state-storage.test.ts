import { describe, expect, it } from "vite-plus/test";
import {
  encodeStoredSessionState,
  parseStoredSessionState,
  type SessionState,
} from "../src/do/session-state.ts";

describe("stored Session Durable Object state", () => {
  it("writes a versioned state and reads it back", () => {
    const state = sessionState();
    const encoded = encodeStoredSessionState(state);

    expect(JSON.parse(encoded)).toMatchObject({ stateFormat: 1 });
    expect(parseStoredSessionState(JSON.parse(encoded))).toEqual(state);
  });

  it("keeps older unversioned state readable and fills later analytics fields", () => {
    const legacy = { ...sessionState() } as Record<string, unknown>;
    delete legacy["totalEventBytes"];
    delete legacy["analyticsVersion"];
    delete legacy["quickBacks"];
    delete legacy["pageTabs"];

    expect(parseStoredSessionState(legacy)).toMatchObject({
      totalEventBytes: 0,
      analyticsVersion: 2,
      quickBacks: 0,
      pageTabs: [],
    });
  });

  it("rejects a broken current state instead of trusting its core identity", () => {
    const broken = {
      stateFormat: 1,
      state: { ...sessionState(), projectId: "../wrong-project" },
    };

    expect(() => parseStoredSessionState(broken)).toThrow("Stored session state is invalid.");
  });

  it("rejects unknown state formats", () => {
    expect(() => parseStoredSessionState({ stateFormat: 2, state: sessionState() })).toThrow(
      "Stored session state is invalid.",
    );
  });
});

function sessionState(): SessionState {
  return {
    projectId: "project_1",
    orgId: "org_1",
    websiteIds: ["website_1"],
    shard: 0,
    retentionDays: 30,
    sessionId: "session_1",
    startedAt: 1_000,
    lastActivity: 2_000,
    lastFlushAt: 1_500,
    bufferedBytes: 0,
    totalPayloadBytes: 20,
    totalEventBytes: 10,
    batchCount: 1,
    segmentCount: 1,
    flags: 0,
    attrs: { country: "US", asn: 64512 },
    firstRequestId: "request_1",
    entryUrl: "/home",
    urlCount: 1,
    analyticsVersion: 2,
    pageCount: 1,
    quickBacks: 0,
    pageTabs: [{ tab: "tab_1", url: "/home", enteredAt: 1_000 }],
  };
}
