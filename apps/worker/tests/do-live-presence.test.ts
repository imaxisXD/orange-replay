import {
  decodeIngestBody,
  manifestKey,
  MAX_PRESENCE_BODY_BYTES,
  MAX_PRESENCE_TEXT_CHARS,
} from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import { presenceShardIndex } from "../src/do/presence-logic.ts";
import {
  append,
  bytes,
  forceFinalize,
  openDoLiveSocket,
  parseTextMessage,
  pollPresenceList,
  presencePing,
  presenceMarkFinalizing,
  presenceRemove,
  readPresenceDebug,
  readPresenceHeads,
  readPresenceInstallStatus,
  readPresenceList,
  readR2Bytes,
  waitForSocketClose,
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

  it("closes a live viewer that sends a client frame", async () => {
    const projectId = "project-live-read-only";
    const sessionId = "session-live-read-only";
    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("live-read-only"),
      t0: Date.now(),
    });

    const connection = openDoLiveSocket(projectId, sessionId);
    await waitForSocketMessage(connection, "hello", 5_000);
    await waitForSocketMessage(connection, "pending batch", 5_000);
    connection.socket.send("unexpected client frame");
    await waitForSocketClose(connection, 5_000);

    expect(connection.status).toMatchObject({
      closed: true,
      closeCode: 1008,
      closeReason: "client messages are not accepted",
    });
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

  it("marks presence finalizing and keeps it for the consumer handoff", async () => {
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

    expect((await readPresenceList(projectId)).sessions).toEqual([]);
    expect(await readPresenceHeads(projectId)).toMatchObject({
      sessions: [{ session_id: sessionId, activity: "finalizing" }],
    });
    expect(await readPresenceDebug(projectId)).toMatchObject({ rows: 1 });
  });

  it("uses the live TTL only for activity and lazily expires old heads", async () => {
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

    const staleLive = await readPresenceList(projectId, 1401);
    expect(staleLive.sessions).toEqual([]);
    const idleHead = await readPresenceHeads(projectId, 1401);
    expect(idleHead.sessions).toMatchObject([{ session_id: sessionId, activity: "idle" }]);
    expect(await readPresenceDebug(projectId)).toMatchObject({ rows: 1 });

    const expired = await readPresenceHeads(projectId, 302_501);
    expect(expired.sessions).toEqual([]);
    expect(await readPresenceDebug(projectId)).toMatchObject({ rows: 0 });

    await presenceRemove(projectId, sessionId);
    await presenceRemove(projectId, sessionId);
    expect(await readPresenceDebug(projectId)).toMatchObject({ rows: 0 });
  });

  it("keeps finalizing presence through an outage and prunes it at replay expiry", async () => {
    const projectId = "project-finalizing-retention";
    const sessionId = "session-finalizing-retention";
    const lastSeen = 1_000;
    const expiresAt = 11_000;

    await presencePing({
      projectId,
      sessionId,
      startedAt: lastSeen,
      lastSeen,
      entryUrl: "/retained",
      expiresAt,
    });
    await presenceMarkFinalizing(projectId, sessionId, 1_100);

    expect(await readPresenceHeads(projectId, expiresAt - 1)).toMatchObject({
      sessions: [{ session_id: sessionId, activity: "finalizing" }],
    });
    expect(await readPresenceHeads(projectId, expiresAt)).toEqual({ sessions: [] });
  });

  it("returns only the newest 100 live rows and reports truncation", async () => {
    const projectId = "project-presence-large-list";
    const now = Date.now();
    const sessionIds: string[] = [];
    for (let candidate = 0; sessionIds.length < 102; candidate += 1) {
      const sessionId = `same_shard_${String(candidate).padStart(4, "0")}`;
      if (presenceShardIndex(sessionId) === 0) sessionIds.push(sessionId);
    }
    const targetSessionId = sessionIds[0];
    if (targetSessionId === undefined) throw new Error("same-shard session setup failed");

    await Promise.all(
      sessionIds.map((sessionId, index) =>
        presencePing({
          projectId,
          sessionId,
          startedAt: now - 200,
          lastSeen: sessionId === targetSessionId ? now - 100 : now,
          entryUrl: `/large/${index}`,
          browser: sessionId === targetSessionId ? "Firefox" : "Chrome",
        }),
      ),
    );

    const list = await readPresenceList(projectId, now);
    expect(list.sessions).toHaveLength(100);
    expect(list.truncated).toBe(true);
    expect(list.sessions.some((session) => session.session_id === targetSessionId)).toBe(false);
    expect(
      await readPresenceHeads(projectId, now, { browser: "Firefox", limit: 10 }),
    ).toMatchObject({ sessions: [{ session_id: targetSessionId, browser: "Firefox" }] });
  });

  it("accepts the largest valid tracked head request within the hard body limit", async () => {
    const projectId = "project-presence-large-request";
    const now = Date.now();
    const trackedSessionIds: string[] = [];
    for (let candidate = 0; trackedSessionIds.length < 100; candidate += 1) {
      const sessionId = `tracked_${String(candidate).padStart(8, "0")}`.padEnd(64, "x");
      if (presenceShardIndex(sessionId) === 0) trackedSessionIds.push(sessionId);
    }
    const text = "x".repeat(MAX_PRESENCE_TEXT_CHARS);
    const query = {
      limit: 100,
      sort: "newest",
      trackedSessionIds,
      before: { sortValue: now, sessionId: trackedSessionIds[0] },
      from: 0,
      to: now,
      country: text,
      region: text,
      device: text,
      browser: text,
      os: text,
      entryUrl: text,
      entryUrlPrefix: text,
      minDurationMs: 0,
    };
    const bodyBytes = new TextEncoder().encode(
      JSON.stringify({ projectId, now, ...query }),
    ).byteLength;

    expect(bodyBytes).toBeGreaterThan(8 * 1024);
    expect(bodyBytes).toBeLessThanOrEqual(MAX_PRESENCE_BODY_BYTES);
    expect(await readPresenceHeads(projectId, now, query)).toEqual({ sessions: [] });
  });

  it("sends stored pending batches to each new viewer in timeline order", async () => {
    const projectId = "project-live-pending";
    const sessionId = "session-live-pending";
    const startedAt = Date.now();

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("first"),
      t0: startedAt,
      receivedAt: startedAt,
    });
    await append({
      projectId,
      sessionId,
      tab: "tab-b",
      seq: 0,
      payload: bytes("third"),
      t0: startedAt + 20,
      receivedAt: startedAt + 20,
    });
    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 1,
      payload: bytes("second"),
      t0: startedAt + 10,
      receivedAt: startedAt + 30,
    });

    for (let viewer = 0; viewer < 2; viewer += 1) {
      const connection = openDoLiveSocket(projectId, sessionId);
      try {
        const hello = parseTextMessage<{ type: string; pendingBatches: number }>(
          await waitForSocketMessage(connection, "hello", 5_000),
        );
        expect(hello).toMatchObject({ type: "hello", pendingBatches: 3 });

        const decoded = [];
        for (let batch = 0; batch < 3; batch += 1) {
          const message = await waitForSocketMessage(connection, "pending batch", 5_000);
          expect(message).toBeInstanceOf(ArrayBuffer);
          decoded.push(decodeIngestBody(new Uint8Array(message as ArrayBuffer)));
        }
        expect(decoded.map((batch) => [batch.index.tab, batch.index.seq])).toEqual([
          ["tab-a", 0],
          ["tab-a", 1],
          ["tab-b", 0],
        ]);
        expect(decoded.map((batch) => new TextDecoder().decode(batch.payload))).toEqual([
          "first",
          "second",
          "third",
        ]);
      } finally {
        connection.socket.close();
      }
    }
  });

  it("sends the final manifest before closing live viewers", async () => {
    const projectId = "project-live-finalized";
    const sessionId = "session-live-finalized";
    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("finalized"),
      t0: Date.now(),
    });

    const connection = openDoLiveSocket(projectId, sessionId);
    try {
      await waitForSocketMessage(connection, "hello", 5_000);
      await waitForSocketMessage(connection, "pending batch", 5_000);
      await forceFinalize(projectId, sessionId);

      const terminal = parseTextMessage<{ type: string; manifest: unknown }>(
        await waitForSocketMessage(connection, "finalized manifest", 5_000),
      );
      expect(terminal.type).toBe("finalized");
      const storedManifest = JSON.parse(
        new TextDecoder().decode(await readR2Bytes(manifestKey(projectId, sessionId))),
      ) as unknown;
      expect(terminal.manifest).toEqual(storedManifest);
    } finally {
      connection.socket.close();
    }
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
