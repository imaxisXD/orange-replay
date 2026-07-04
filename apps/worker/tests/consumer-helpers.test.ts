import { manifestKey, type FinalizeMessage } from "@orange-replay/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { handleFinalizeBatch } from "../src/consumer/queue.ts";
import {
  expiresAtFromEndedAt,
  truncateEventDetail,
  usageMonthFromStartedAt,
} from "../src/consumer/helpers.ts";
import { sweepExpiredSessions } from "../src/consumer/sweeper.ts";
import type { Env } from "../src/env.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("consumer helper logic", () => {
  it("derives the usage month from the session start time", () => {
    const startedAt = Date.UTC(2026, 0, 31, 23, 59, 59);

    expect(usageMonthFromStartedAt(startedAt)).toBe("2026-01");
  });

  it("truncates event detail to 200 characters", () => {
    const detail = "a".repeat(250);

    expect(truncateEventDetail(detail)).toHaveLength(200);
    expect(truncateEventDetail(undefined)).toBeNull();
  });

  it("derives the expiry time from ended_at and retention days", () => {
    const endedAt = Date.UTC(2026, 5, 1, 12, 0, 0);

    expect(expiresAtFromEndedAt(endedAt, 7)).toBe(endedAt + 7 * 86_400_000);
  });
});

describe("consumer wide events", () => {
  it("marks the final retry attempt as a DLQ drop", async () => {
    const log = vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);
    const error = vi.spyOn(globalThis["console"], "error").mockImplementation(() => undefined);
    const retry = vi.fn();
    const ack = vi.fn();
    const message = {
      body: makeFinalizeMessage("dlq"),
      attempts: 10,
      ack,
      retry,
    } as unknown as Parameters<typeof handleFinalizeBatch>[0]["messages"][number];

    await handleFinalizeBatch(
      { messages: [message] } as Parameters<typeof handleFinalizeBatch>[0],
      {} as Env,
      {} as Parameters<typeof handleFinalizeBatch>[2],
    );

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(parsed["outcome"]).toBe("dropped");
    expect(parsed["dlq"]).toBe(true);
    expect(parsed["attempts"]).toBe(10);
  });

  it("emits cron sweep logs with a UUIDv7 request id", async () => {
    const log = vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);
    const env = makeEmptySweepEnv();

    await sweepExpiredSessions(env);

    expect(log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(parsed["request_id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(parsed["sessions_deleted"]).toBe(0);
    expect(parsed["objects_deleted"]).toBe(0);
  });
});

function makeFinalizeMessage(name: string): FinalizeMessage {
  const sessionId = `session-${name}`;
  const projectId = `project-${name}`;
  const startedAt = Date.UTC(2026, 0, 15, 10, 0, 0);

  return {
    type: "session.finalized",
    sessionId,
    projectId,
    orgId: `org-${name}`,
    shard: 0,
    requestId: `request-${name}`,
    manifestKey: manifestKey(projectId, sessionId),
    startedAt,
    endedAt: startedAt + 1_000,
    bytes: 100,
    segments: 1,
    flags: 0,
    counts: { batches: 1, events: 1, clicks: 0, errors: 1, rages: 0, navs: 0 },
    attrs: {},
    retentionDays: 30,
    events: [{ t: startedAt, k: "error", d: "failed" }],
  };
}

function makeEmptySweepEnv(): Env {
  const all = vi.fn(async () => ({ results: [] }));
  const bind = vi.fn(() => ({ all }));
  const prepare = vi.fn(() => ({ bind }));

  return {
    IDX_00: { prepare },
  } as unknown as Env;
}
