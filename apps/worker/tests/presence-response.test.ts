import { describe, expect, it } from "vite-plus/test";
import {
  decodePresenceHeadBody,
  decodePresenceInstallBody,
  decodePresenceListBody,
} from "../src/do/presence-response.ts";

describe("Presence response decoders", () => {
  it("decodes a complete Presence list response", () => {
    expect(decodePresenceListBody({ sessions: [presenceSession()] })).toEqual({
      sessions: [presenceSession()],
    });
  });

  it("rejects malformed session values", () => {
    expect(() =>
      decodePresenceListBody({
        sessions: [{ ...presenceSession(), last_seen: "recently" }],
      }),
    ).toThrow("Presence list response is invalid.");
  });

  it("requires the head response shape instead of treating missing data as empty", () => {
    expect(() => decodePresenceHeadBody({})).toThrow("Presence head response is invalid.");
  });

  it("rejects invalid ids and install timestamps", () => {
    expect(() =>
      decodePresenceListBody({
        sessions: [{ ...presenceSession(), session_id: "bad/session" }],
      }),
    ).toThrow("Presence list response is invalid.");
    expect(() => decodePresenceInstallBody({ firstEventAt: -1 })).toThrow(
      "Presence install status response is invalid.",
    );
  });
});

function presenceSession() {
  return {
    session_id: "session_1",
    org_id: "org_1",
    started_at: 1_000,
    last_seen: 2_000,
    finalizing_at: null,
    entry_url: "/home",
    country: "US",
    region: "CA",
    city: "San Francisco",
    browser: "Chrome",
    os: "macOS",
    device: "Desktop",
    flags: 0,
  };
}
