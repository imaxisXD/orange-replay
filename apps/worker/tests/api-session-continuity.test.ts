import {
  listSessionHeadsResponseSchema,
  liveSessionsResponseSchema,
  sessionHeadSchema,
  type ListSessionHeadsResponse,
  type SessionHead,
} from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import { presenceShardIndex } from "../src/do/presence-logic.ts";
import {
  appendActiveSession,
  authHeaders,
  listProjectId,
  presencePing,
  setupApiTestWorkers,
  worker,
  workerWithPresenceHeadFailure,
} from "./api-test-helpers.ts";

setupApiTestWorkers({ presenceHeadFailure: true });

interface HeadControls {
  openedAt: number;
  warehouseTo?: number;
  trackedSessionIds?: string[];
}

describe("session continuity api", () => {
  it("keeps every exact candidate read on its named index", async () => {
    const expectedIndexes = {
      outbox: "idx_analytics_export_outbox_project_kind_sequence",
      ledger: "idx_analytics_export_ledger_project_kind_sequence",
      started: "idx_sessions_project_time",
      indexed: "idx_sessions_project_indexed_at",
      latestIndexed: "idx_sessions_project_indexed_at",
      point: "sqlite_autoindex_sessions_1",
    } as const;

    for (const [source, expectedIndex] of Object.entries(expectedIndexes)) {
      const response = await worker.fetch(
        `/__test/api/session-head-plan?projectId=${listProjectId}&source=${source}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { plan: string[] };
      expect(body.plan.some((step) => step.includes(expectedIndex))).toBe(true);
      expect(body.plan.some((step) => step.includes("USE TEMP B-TREE"))).toBe(false);
      if (source === "point") {
        expect(body.plan.some((step) => /SCAN (?:sessions|s)(?:\s|$)/.test(step))).toBe(false);
      }
    }
  });

  it("requires separate, safe continuity controls", async () => {
    const missing = await worker.fetch(`/api/v1/projects/${listProjectId}/session-heads`, {
      headers: authHeaders(),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "invalid_opened_at" });

    const duplicate = await worker.fetch(
      `/api/v1/projects/${listProjectId}/session-heads?opened_at=1&opened_at=2`,
      { headers: authHeaders() },
    );
    expect(duplicate.status).toBe(400);

    const futureWarehouse = await worker.fetch(
      `/api/v1/projects/${listProjectId}/session-heads?opened_at=1&warehouse_to=2`,
      { headers: authHeaders() },
    );
    expect(futureWarehouse.status).toBe(400);

    const invalidTracked = await worker.fetch(
      `/api/v1/projects/${listProjectId}/session-heads?opened_at=1&tracked_session_id=bad%2Fid`,
      { headers: authHeaders() },
    );
    expect(invalidTracked.status).toBe(400);
    expect(await invalidTracked.json()).toEqual({ error: "invalid_tracked_session_id" });

    const tooManyTracked = new URLSearchParams({ opened_at: "1" });
    for (let index = 0; index < 101; index += 1) {
      tooManyTracked.append("tracked_session_id", `tracked_${String(index)}`);
    }
    const tooMany = await worker.fetch(
      `/api/v1/projects/${listProjectId}/session-heads?${tooManyTracked.toString()}`,
      { headers: authHeaders() },
    );
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toEqual({ error: "too_many_tracked_session_ids" });
  });

  it("fails the head poll when one Presence shard is unavailable", async () => {
    const response = await workerWithPresenceHeadFailure.fetch(
      `/api/v1/projects/${listProjectId}/session-heads?opened_at=${Date.now()}`,
      { headers: authHeaders() },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "presence_unavailable" });
  });

  it("shows the first accepted batch in heads and state without caching it", async () => {
    const sessionId = "api_continuity_live";
    const entryUrl = "/continuity/live";
    await appendActiveSession(listProjectId, sessionId, entryUrl);

    const response = await pollHeads(`entry_url=${encodeURIComponent(entryUrl)}`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toMatchObject({
      sessions: [
        {
          session_id: sessionId,
          entry_url: entryUrl,
          activity: "live",
          details_state: "provisional",
          replay_source: "live",
        },
      ],
    });

    const state = await readState(sessionId);
    expect(state).toMatchObject({
      session_id: sessionId,
      activity: "live",
      details_state: "provisional",
      replay_source: "live",
    });
  });

  it("keeps an idle session head after it leaves Live and marks finalizing in place", async () => {
    const sessionId = "api_continuity_idle";
    const entryUrl = "/continuity/idle";
    const lastSeen = Date.now() - 61_000;
    await presencePing({
      projectId: listProjectId,
      sessionId,
      startedAt: lastSeen - 1_000,
      lastSeen,
      entryUrl,
    });

    const live = await worker.fetch(`/api/v1/projects/${listProjectId}/live`, {
      headers: authHeaders(),
    });
    expect(live.status).toBe(200);
    expect(liveSessionsResponseSchema.parse(await live.json())).not.toMatchObject({
      sessions: [{ session_id: sessionId }],
    });
    expect(await readHeads(`entry_url=${encodeURIComponent(entryUrl)}`)).toMatchObject({
      sessions: [
        {
          session_id: sessionId,
          duration_ms: 1_000,
          activity: "idle",
          details_state: "provisional",
          replay_source: "live",
        },
      ],
    });

    const mark = await worker.fetch("/__test/do/presence/mark-finalizing", {
      method: "POST",
      body: JSON.stringify({ projectId: listProjectId, sessionId, finalizingAt: Date.now() }),
    });
    expect(mark.status).toBe(200);
    expect(await readState(sessionId)).toMatchObject({
      session_id: sessionId,
      activity: "finalizing",
      details_state: "provisional",
      replay_source: "recorded",
    });
  });

  it("bridges only export rows newer than the warehouse watermark", async () => {
    await seedSessionExport("api_new", 9_001, "outbox");
    const controls = { openedAt: 10_000, warehouseTo: 5_000 };

    expect(
      await readHeads("entry_url=%2Fcheckout%2Fcomplete&warehouse_version=9000", controls),
    ).toMatchObject({
      sessions: [
        {
          session_id: "api_new",
          activity: "complete",
          details_state: "exact",
          replay_source: "recorded",
        },
      ],
    });
    expect(
      await readHeads("entry_url=%2Fcheckout%2Fcomplete&warehouse_version=9001", controls),
    ).toEqual({ sessions: [] });

    await seedSessionExport("api_new", 9_002, "ledger");
    expect(
      await readHeads("entry_url=%2Fcheckout%2Fcomplete&warehouse_version=9001", controls),
    ).toMatchObject({ sessions: [{ session_id: "api_new", details_state: "exact" }] });
    expect(
      await readHeads("entry_url=%2Fcheckout%2Fcomplete&warehouse_version=9002", controls),
    ).toEqual({ sessions: [] });
  });

  it("bridges a session that started after the frozen warehouse date", async () => {
    expect(
      await readHeads("entry_url=%2Fcheckout%2Fcomplete&warehouse_version=9002", {
        openedAt: 10_000,
        warehouseTo: 2_500,
      }),
    ).toMatchObject({ sessions: [{ session_id: "api_new", details_state: "exact" }] });
  });

  it("uses commit time for a 30-minute idle session when analytics export is off", async () => {
    await markSessionIndexed("api_old", 40_000);

    expect(
      await readHeads("entry_url=%2Fcheckout%2Fstart&warehouse_version=9002", {
        openedAt: 30_000,
        warehouseTo: 10_000,
      }),
    ).toMatchObject({
      sessions: [
        {
          session_id: "api_old",
          ended_at: 2_500,
          activity: "complete",
          details_state: "exact",
        },
      ],
    });
    expect(
      await readHeads("entry_url=%2Fcheckout%2Fstart&warehouse_version=9002", {
        openedAt: 50_000,
        warehouseTo: 10_000,
      }),
    ).toEqual({ sessions: [] });
  });

  it("falls back to the latest indexed sessions when no warehouse watermark is available", async () => {
    expect(
      await readHeads("entry_url=%2Fcheckout%2Fstart", {
        openedAt: 50_000,
        warehouseTo: 10_000,
      }),
    ).toMatchObject({
      sessions: [
        {
          session_id: "api_old",
          ended_at: 2_500,
          activity: "complete",
          details_state: "exact",
        },
      ],
    });
  });

  it("keeps a tracked visible head across more than 100 unrelated commits", async () => {
    const noise = await worker.fetch("/__test/api/seed-session-head-noise", {
      method: "POST",
      body: JSON.stringify({ projectId: listProjectId, count: 101, indexedAt: 60_000 }),
    });
    expect(noise.status).toBe(200);

    const result = await readHeads("limit=100", {
      openedAt: 60_000,
      warehouseTo: 10_000,
      trackedSessionIds: ["api_old"],
    });
    expect(result.sessions).toHaveLength(101);
    expect(result.sessions).toContainEqual(
      expect.objectContaining({ session_id: "api_old", details_state: "exact" }),
    );
  });

  it("keeps a tracked idle presence head behind more than 100 newer rows", async () => {
    const trackedSessionId = "api_tracked_idle_presence";
    const targetShard = presenceShardIndex(trackedSessionId);
    const noiseSessionIds: string[] = [];
    for (let candidate = 0; noiseSessionIds.length < 101; candidate += 1) {
      const sessionId = `api_presence_noise_${String(candidate).padStart(4, "0")}`;
      if (presenceShardIndex(sessionId) === targetShard) noiseSessionIds.push(sessionId);
    }
    const now = Date.now();
    await presencePing({
      projectId: listProjectId,
      sessionId: trackedSessionId,
      startedAt: now - 120_000,
      lastSeen: now - 61_000,
      entryUrl: "/tracked/idle",
    });
    await Promise.all(
      noiseSessionIds.map((sessionId, index) =>
        presencePing({
          projectId: listProjectId,
          sessionId,
          startedAt: now - 1_000 + index,
          lastSeen: now,
          entryUrl: `/presence/noise/${index}`,
        }),
      ),
    );

    const result = await readHeads("limit=100", {
      openedAt: now,
      trackedSessionIds: [trackedSessionId],
    });
    expect(result.sessions).toHaveLength(101);
    expect(result.sessions).toContainEqual(
      expect.objectContaining({
        session_id: trackedSessionId,
        activity: "idle",
        details_state: "provisional",
      }),
    );
  });

  it("drops deleted presence and tracked exact candidates", async () => {
    const presenceSessionId = "api_deleted_presence";
    const now = Date.now();
    await presencePing({
      projectId: listProjectId,
      sessionId: presenceSessionId,
      startedAt: now - 1_000,
      lastSeen: now,
      entryUrl: "/deleted/presence",
    });
    await seedDeletionMarker(presenceSessionId);
    expect(await readHeads("entry_url=%2Fdeleted%2Fpresence")).toEqual({ sessions: [] });

    await seedDeletionMarker("api_old");
    expect(
      await readHeads("entry_url=%2Fcheckout%2Fstart", {
        openedAt: 60_000,
        warehouseTo: 10_000,
        trackedSessionIds: ["api_old"],
      }),
    ).toEqual({ sessions: [] });
  });

  it("leaves unsupported sorts and exact-only filters to the complete session list", async () => {
    expect(
      await readHeads("sort=friction&entry_url=%2Fcheckout%2Fcomplete", {
        openedAt: 0,
        warehouseTo: 0,
        trackedSessionIds: ["api_new"],
      }),
    ).toEqual({ sessions: [] });
    expect(
      await readHeads("has_errors=1&entry_url=%2Fcheckout%2Fcomplete", {
        openedAt: 0,
        warehouseTo: 0,
        trackedSessionIds: ["api_new"],
      }),
    ).toEqual({ sessions: [] });
  });

  it("returns exact state and enforces auth and missing-session errors", async () => {
    expect(await readState("api_new")).toMatchObject({
      session_id: "api_new",
      activity: "complete",
      details_state: "exact",
      replay_source: "recorded",
    });

    const missing = await worker.fetch(
      `/api/v1/projects/${listProjectId}/sessions/api_missing/state`,
      { headers: authHeaders() },
    );
    expect(missing.status).toBe(404);
    const unauthorized = await worker.fetch(
      `/api/v1/projects/${listProjectId}/session-heads?opened_at=1`,
    );
    expect(unauthorized.status).toBe(401);
  });
});

async function pollHeads(query: string): Promise<Response> {
  const startedAt = Date.now();
  for (;;) {
    const response = await worker.fetch(headsPath(query), { headers: authHeaders() });
    if (response.status === 200) {
      const body = listSessionHeadsResponseSchema.parse(await response.clone().json());
      if (body.sessions.length > 0) return response;
    }
    if (Date.now() - startedAt >= 3_000) return response;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function readHeads(
  query: string,
  controls: HeadControls = { openedAt: Date.now() },
): Promise<ListSessionHeadsResponse> {
  const response = await worker.fetch(headsPath(query, controls), { headers: authHeaders() });
  expect(response.status).toBe(200);
  return listSessionHeadsResponseSchema.parse(await response.json());
}

function headsPath(query: string, controls: HeadControls = { openedAt: Date.now() }): string {
  const params = new URLSearchParams(query);
  params.set("opened_at", String(controls.openedAt));
  if (controls.warehouseTo !== undefined) {
    params.set("warehouse_to", String(controls.warehouseTo));
  }
  for (const sessionId of controls.trackedSessionIds ?? []) {
    params.append("tracked_session_id", sessionId);
  }
  return `/api/v1/projects/${listProjectId}/session-heads?${params.toString()}`;
}

async function readState(sessionId: string): Promise<SessionHead> {
  const response = await worker.fetch(
    `/api/v1/projects/${listProjectId}/sessions/${sessionId}/state`,
    { headers: authHeaders() },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return sessionHeadSchema.parse(await response.json());
}

async function seedSessionExport(
  sessionId: string,
  exportSequence: number,
  location: "outbox" | "ledger",
): Promise<void> {
  const response = await worker.fetch("/__test/api/seed-session-export", {
    method: "POST",
    body: JSON.stringify({
      projectId: listProjectId,
      sessionId,
      exportSequence,
      location,
    }),
  });
  expect(response.status).toBe(200);
}

async function markSessionIndexed(sessionId: string, indexedAt: number): Promise<void> {
  const response = await worker.fetch("/__test/api/mark-session-indexed", {
    method: "POST",
    body: JSON.stringify({ projectId: listProjectId, sessionId, indexedAt }),
  });
  expect(response.status).toBe(200);
}

async function seedDeletionMarker(sessionId: string): Promise<void> {
  const response = await worker.fetch("/__test/consumer/seed-deletion", {
    method: "POST",
    body: JSON.stringify({ projectId: listProjectId, sessionId }),
  });
  expect(response.status).toBe(200);
}
