import { describe, expect, it } from "vite-plus/test";
import {
  append,
  bytes,
  forceFinalize,
  openDoLiveSocket,
  parseTextMessage,
  pollPresenceList,
  presencePing,
  presenceRemove,
  readPresenceDebug,
  readPresenceInstallStatus,
  readPresenceList,
  waitForSocketMessage,
} from "./do-test-helpers.ts";

describe("SessionRecorder Durable Object", () => {
  it("asks the next append for one live join checkpoint", async () => {
    const projectId = "project-live-checkpoint";
    const sessionId = "session-live-checkpoint";
    const payload = bytes("payload-live-checkpoint");

    await append({ projectId, sessionId, tab: "tab-a", seq: 0, payload, t0: 1500 });

    const conn = openDoLiveSocket(projectId, sessionId);
    try {
      const helloMessage = await waitForSocketMessage(conn, "hello", 5_000);
      const hello = parseTextMessage<{
        type: string;
        sessionId: string;
        snapshot: {
          counts: { batches: number; events: number };
          timeline: Array<{ k: string }>;
        };
      }>(helloMessage);
      expect(hello).toMatchObject({ type: "hello", sessionId });
      expect(hello.snapshot.counts).toMatchObject({ batches: 1, events: 1 });
      expect(hello.snapshot.timeline).toEqual([expect.objectContaining({ k: "custom" })]);

      const checkpointResult = await append({
        projectId,
        sessionId,
        tab: "tab-a",
        seq: 1,
        payload,
        t0: 1600,
      });
      expect(checkpointResult.checkpoint).toBe(true);

      const normalResult = await append({
        projectId,
        sessionId,
        tab: "tab-a",
        seq: 2,
        payload,
        t0: 1700,
      });
      expect("checkpoint" in normalResult).toBe(false);
    } finally {
      conn.socket.close();
    }
  });

  it("pings presence on start and throttles heartbeat updates", async () => {
    const projectId = "project-presence-heartbeat";
    const sessionId = "session-presence-heartbeat";
    const startedAt = Date.now();

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("presence-start"),
      t0: startedAt,
      receivedAt: startedAt,
      url: "/start",
      attrs: {
        country: "US",
        city: "Austin",
        browser: "Chrome",
        os: "macOS",
        device: "desktop",
      },
    });

    const firstList = await pollPresenceList(
      projectId,
      (body) => body.sessions.length === 1,
      startedAt + 10,
    );
    expect(firstList.sessions[0]).toMatchObject({
      session_id: sessionId,
      started_at: startedAt,
      last_seen: startedAt,
      entry_url: "/start",
      country: "US",
      city: "Austin",
      browser: "Chrome",
      os: "macOS",
      device: "desktop",
    });

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 1,
      payload: bytes("presence-too-soon"),
      t0: startedAt + 50,
      receivedAt: startedAt + 50,
    });
    const throttledList = await readPresenceList(projectId, startedAt + 60);
    expect(throttledList.sessions[0]?.last_seen).toBe(startedAt);

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 2,
      payload: bytes("presence-heartbeat"),
      t0: startedAt + 250,
      receivedAt: startedAt + 250,
    });
    const heartbeatList = await pollPresenceList(
      projectId,
      (body) => body.sessions[0]?.last_seen === startedAt + 250,
      startedAt + 260,
    );
    expect(heartbeatList.sessions[0]?.last_seen).toBe(startedAt + 250);
  });

  it("removes presence on finalize", async () => {
    const projectId = "project-presence-remove";
    const sessionId = "session-presence-remove";

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("presence-remove"),
      t0: Date.now(),
    });
    await pollPresenceList(projectId, (body) => body.sessions.length === 1);
    await forceFinalize(projectId, sessionId);

    const removed = await pollPresenceList(projectId, (body) => body.sessions.length === 0);
    expect(removed.sessions).toEqual([]);
  });

  it("uses lazy TTL eviction and keeps duplicate pings and removes safe", async () => {
    const projectId = "project-presence-ttl";
    const sessionId = "session-presence-ttl";

    await presencePing({
      projectId,
      sessionId,
      startedAt: 1000,
      lastSeen: 1000,
      entryUrl: "/old",
    });
    await presencePing({
      projectId,
      sessionId,
      startedAt: 1000,
      lastSeen: 1000,
      entryUrl: "/old",
    });

    const active = await readPresenceList(projectId, 1200);
    expect(active.sessions.map((session) => session.session_id)).toEqual([sessionId]);

    const stale = await readPresenceList(projectId, 1401);
    expect(stale.sessions).toEqual([]);
    expect(await readPresenceDebug(projectId)).toMatchObject({ rows: 0 });

    await presenceRemove(projectId, sessionId);
    await presenceRemove(projectId, sessionId);
    expect(await readPresenceDebug(projectId)).toMatchObject({ rows: 0 });
  });

  it("keeps presence time and metadata monotonic", async () => {
    const projectId = "project-presence-monotonic";
    const sessionId = "session-presence-monotonic";

    await presencePing({
      projectId,
      sessionId,
      startedAt: 1000,
      lastSeen: 3000,
      entryUrl: "/new",
      browser: "Firefox",
    });
    await presencePing({
      projectId,
      sessionId,
      startedAt: 1000,
      lastSeen: 2000,
      entryUrl: "/old",
      browser: "Safari",
    });

    const active = await readPresenceList(projectId, 3200);
    expect(active.sessions).toMatchObject([
      {
        session_id: sessionId,
        last_seen: 3000,
        entry_url: "/new",
        browser: "Firefox",
      },
    ]);
  });

  it("sets install status only on the first presence ping", async () => {
    const projectId = "project-install-status";

    expect(await readPresenceInstallStatus(projectId)).toEqual({ firstEventAt: null });

    await presencePing({
      projectId,
      sessionId: "session-install-a",
      startedAt: 2000,
      lastSeen: 2000,
      entryUrl: "/first",
    });
    expect(await readPresenceInstallStatus(projectId)).toEqual({ firstEventAt: 2000 });

    await presencePing({
      projectId,
      sessionId: "session-install-b",
      startedAt: 3000,
      lastSeen: 3000,
      entryUrl: "/second",
    });
    expect(await readPresenceInstallStatus(projectId)).toEqual({ firstEventAt: 2000 });
  });
});
