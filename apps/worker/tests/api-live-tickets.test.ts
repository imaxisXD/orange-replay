import type { Socket } from "node:net";
import { MAX_LIVE_VIEWERS_PER_ACTOR } from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  appendActiveSession,
  assetProjectId,
  assetSessionId,
  authHeaders,
  makeProjectConfig,
  mintTicket,
  requestLiveUpgrade,
  seedIngestKey,
  setupApiTestWorkers,
  signLiveTicket,
  signLiveTicketWithSecret,
  testWriteKey,
  ticketProjectId,
  ticketSessionId,
  worker,
  workerWithoutLiveTicketSecret,
} from "./api-test-helpers.ts";

setupApiTestWorkers({ withoutLiveTicketSecret: true });

describe("dashboard api", () => {
  it("mints live tickets only with a Better Auth session", async () => {
    const missing = await worker.fetch(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live-ticket`,
      { method: "POST" },
    );
    expect(missing.status).toBe(401);

    const res = await worker.fetch(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live-ticket`,
      {
        method: "POST",
        headers: authHeaders(),
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ticket: expect.any(String),
      expiresAt: expect.any(Number),
    });
  });

  it("returns the durable object's live response status with a valid ticket", async () => {
    const ticket = await mintTicket(assetProjectId, assetSessionId);
    const res = await requestLiveUpgrade(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live?ticket=${encodeURIComponent(
        ticket,
      )}`,
    );

    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not_found" });
  });

  it("connects live WebSockets with tickets and rejects old query credentials", async () => {
    await seedIngestKey(
      testWriteKey("api_ticket"),
      makeProjectConfig({ projectId: ticketProjectId, orgId: "api_ticket_org" }),
      false,
    );
    await appendActiveSession(ticketProjectId, ticketSessionId);

    const ticket = await mintTicket(ticketProjectId, ticketSessionId);
    const connected = await requestLiveUpgrade(
      `/api/v1/projects/${ticketProjectId}/sessions/${ticketSessionId}/live?ticket=${encodeURIComponent(
        ticket,
      )}`,
    );
    expect(connected.status).toBe(101);

    const tokenFallback = await requestLiveUpgrade(
      `/api/v1/projects/${ticketProjectId}/sessions/${ticketSessionId}/live?token=old-dashboard-credential`,
    );
    expect(tokenFallback.status).toBe(401);
    expect(JSON.parse(tokenFallback.body)).toEqual({ error: "unauthorized" });
  });

  it("accepts a live ticket once and rejects a replay", async () => {
    const capProjectId = ticketProjectId;
    const capSessionId = "api_cap_session";
    await appendActiveSession(capProjectId, capSessionId);

    const ticket = await mintTicket(capProjectId, capSessionId);
    const path = `/api/v1/projects/${capProjectId}/sessions/${capSessionId}/live?ticket=${encodeURIComponent(
      ticket,
    )}`;
    expect((await requestLiveUpgrade(path)).status).toBe(101);

    const replay = await requestLiveUpgrade(path);
    expect(replay.status).toBe(409);
    expect(JSON.parse(replay.body)).toEqual({ error: "ticket_used" });
  });

  it("caps concurrent live viewers for one signed-in actor", async () => {
    const capProjectId = ticketProjectId;
    const capSessionId = "api_actor_cap_session";
    await appendActiveSession(capProjectId, capSessionId);

    const held: Socket[] = [];
    try {
      for (let i = 0; i < MAX_LIVE_VIEWERS_PER_ACTOR; i++) {
        const ticket = await mintTicket(capProjectId, capSessionId);
        const path = `/api/v1/projects/${capProjectId}/sessions/${capSessionId}/live?ticket=${encodeURIComponent(
          ticket,
        )}`;
        const res = await requestLiveUpgrade(path, worker, held);
        expect(res.status).toBe(101);
      }

      const ticket = await mintTicket(capProjectId, capSessionId);
      const path = `/api/v1/projects/${capProjectId}/sessions/${capSessionId}/live?ticket=${encodeURIComponent(
        ticket,
      )}`;
      const rejected = await requestLiveUpgrade(path, worker, held);
      expect(rejected.status).toBe(429);
      expect(JSON.parse(rejected.body)).toEqual({ error: "viewer_actor_limit" });
    } finally {
      for (const socket of held) socket.destroy();
    }
  });

  it("rejects garbage, expired, and cross-session live tickets", async () => {
    const validForOtherSession = await mintTicket(assetProjectId, "other_session");
    const expired = signLiveTicket(assetProjectId, assetSessionId, Date.now() - 1);

    for (const ticket of ["garbage", expired, validForOtherSession]) {
      const res = await requestLiveUpgrade(
        `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live?ticket=${encodeURIComponent(
          ticket,
        )}`,
      );
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
    }
  });

  it("rejects forged live tickets when the live ticket secret is missing", async () => {
    const forged = signLiveTicketWithSecret(
      "",
      assetProjectId,
      assetSessionId,
      Date.now() + 60_000,
    );
    const res = await requestLiveUpgrade(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live?ticket=${encodeURIComponent(
        forged,
      )}`,
      workerWithoutLiveTicketSecret,
    );

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
  });

  it("rejects live tickets signed with an unrelated dashboard value", async () => {
    const forged = signLiveTicketWithSecret(
      "old-dashboard-credential",
      assetProjectId,
      assetSessionId,
      Date.now() + 60_000,
    );
    const res = await requestLiveUpgrade(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live?ticket=${encodeURIComponent(
        forged,
      )}`,
    );

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
  });
});
