import { describe, expect, it, vi } from "vite-plus/test";
import { mintLiveTicket } from "../src/api/live-ticket.ts";
import type { Env } from "../src/env.ts";

const productionBase = {
  LIVE_TICKET_SECRET: "x".repeat(40),
  WORKER_ENV: "production",
} as Env;

describe("live ticket production rate limit", () => {
  it("fails closed when the limiter binding is missing", async () => {
    const response = await mintLiveTicket(
      productionBase,
      "project_one",
      "session_one",
      "user:private-id",
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
  });

  it("returns 429 when the limiter denies the hashed viewer key", async () => {
    const limit = vi.fn(async (_input: { key: string }) => ({ success: false }));
    const response = await mintLiveTicket(
      { ...productionBase, LIVE_TICKET_RATE_LIMITER: { limit } },
      "project_one",
      "session_one",
      "user:private-id",
    );

    expect(response.status).toBe(429);
    const key = limit.mock.calls[0]?.[0].key;
    expect(key).toMatch(/^live-ticket:[a-f0-9]{64}$/);
    expect(key).not.toContain("private-id");
  });

  it("fails closed when the limiter throws", async () => {
    const response = await mintLiveTicket(
      {
        ...productionBase,
        LIVE_TICKET_RATE_LIMITER: {
          limit: async () => {
            throw new Error("limiter unavailable");
          },
        },
      },
      "project_one",
      "session_one",
      "user:private-id",
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
  });
});
