import { describe, expect, it, vi } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { SessionRecorder } from "../src/do/session-recorder.ts";
import type { SessionState } from "../src/do/session-state.ts";

describe("session recovery races", () => {
  it("owns finalization while first registration is still waiting", async () => {
    let release = () => {};
    const registration = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writeManifest = vi.fn(async () => {});
    const state = { projectId: "project", sessionId: "session", shard: 0 } as SessionState;
    const object = Object.assign(Object.create(SessionRecorder.prototype), {
      activeFinalize: null,
      sessionState: state,
      finalizedTombstone: null,
      finalizationCancelled: false,
      persistSessionState: () => {},
      ensureFinalizationRegistered: vi.fn(() => registration),
      finalizeNow: writeManifest,
      env: { IDX_00: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } },
    });
    const first = object.finalizeForTest();
    const second = object.finalizeForTest();
    expect(object.ensureFinalizationRegistered).toHaveBeenCalledOnce();
    expect(writeManifest).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(writeManifest).toHaveBeenCalledOnce();
  });

  it("rejects sequence zero after cold recreation when only the deletion fence remains", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(
      "CREATE TABLE sessions(project_id TEXT, session_id TEXT); CREATE TABLE session_deletions(project_id TEXT, session_id TEXT); INSERT INTO session_deletions VALUES ('project', 'session')",
    );
    const initialize = vi.fn();
    const object = Object.assign(Object.create(SessionRecorder.prototype), {
      sessionState: null,
      finalizedTombstone: null,
      finalizationCancelled: false,
      appendRateLimit: { windowStartedAt: 0, count: 0 },
      segmentWriter: { recordingExists: async () => false },
      initializeState: initialize,
      env: {
        IDX_00: {
          prepare: (sql: string) => ({
            bind: (...values: string[]) => ({
              first: async () => sqlite.prepare(sql).get(...values) ?? null,
            }),
          }),
        },
      },
    });
    try {
      const result = await object.appendBatch({
        projectId: "project",
        orgId: "org",
        sessionId: "session",
        shard: 0,
        tab: "tab",
        seq: 0,
        receivedAt: Date.now(),
        requestId: "cold-recreation",
        payload: new Uint8Array([1]),
        index: { v: 1, s: "session", tab: "tab", seq: 0, t0: 1, t1: 2, e: [] },
      });
      expect(result.closed).toBe(true);
      expect(object.sessionState).toBeNull();
      expect(initialize).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });
});
