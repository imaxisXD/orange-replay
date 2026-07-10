import type { Socket } from "node:net";
import { MAX_LIVE_VIEWERS_PER_SESSION } from "@orange-replay/shared";
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
  token,
  worker,
  workerWithEmptyToken,
} from "./api-test-helpers.ts";

setupApiTestWorkers({ emptyToken: true });

describe("dashboard api", () => {
  it("mints live tickets only with bearer auth", async () => {
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

  it("connects live WebSockets with tickets and rejects token fallback", async () => {
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
      `/api/v1/projects/${ticketProjectId}/sessions/${ticketSessionId}/live?token=${token}`,
    );
    expect(tokenFallback.status).toBe(401);
    expect(JSON.parse(tokenFallback.body)).toEqual({ error: "unauthorized" });
  });

  it("caps concurrent live viewers per session even when one ticket is replayed", async () => {
    const capProjectId = ticketProjectId;
    const capSessionId = "api_cap_session";
    await appendActiveSession(capProjectId, capSessionId);

    // One ticket, replayed: connections succeed only up to the viewer cap.
    const ticket = await mintTicket(capProjectId, capSessionId);
    const path = `/api/v1/projects/${capProjectId}/sessions/${capSessionId}/live?ticket=${encodeURIComponent(
      ticket,
    )}`;
    const held: Socket[] = [];
    try {
      for (let i = 0; i < MAX_LIVE_VIEWERS_PER_SESSION; i++) {
        const res = await requestLiveUpgrade(path, worker, held);
        expect(res.status).toBe(101);
      }

      const rejected = await requestLiveUpgrade(path, worker, held);
      expect(rejected.status).toBe(429);
      expect(JSON.parse(rejected.body)).toEqual({ error: "viewer_limit" });
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

  it("rejects forged live tickets when the API token is empty", async () => {
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
      workerWithEmptyToken,
    );

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
  });

  it("rejects live tickets signed with the dashboard API token", async () => {
    const forged = signLiveTicketWithSecret(
      token,
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
