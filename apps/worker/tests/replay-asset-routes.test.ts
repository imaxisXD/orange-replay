import { describe, expect, it, vi } from "vite-plus/test";
import { getReplayAsset } from "../src/api/session-routes.ts";
import type { Env } from "../src/env.ts";

describe("private replay asset route", () => {
  it("returns not found when the requested hash is not mapped to that session", async () => {
    const get = vi.fn();
    const response = await getReplayAsset(
      assetRouteEnv({ mappedHash: "a".repeat(64), get }),
      "project-a",
      "session-a",
      "b".repeat(64),
    );

    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("serves only mapped bytes with the retention-safe private cache bound", async () => {
    const hash = "a".repeat(64);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const response = await getReplayAsset(
      assetRouteEnv({ mappedHash: hash, bytes }),
      "project-a",
      "session-a",
      hash,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300, must-revalidate");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
});

function assetRouteEnv({
  bytes = new Uint8Array([1]),
  get = vi.fn(),
  mappedHash,
}: {
  bytes?: Uint8Array;
  get?: ReturnType<typeof vi.fn>;
  mappedHash: string;
}): Env {
  const prepare = vi.fn((query: string) => ({
    bind: (...values: unknown[]) => ({
      first: async () => {
        if (query.includes("session_deletions")) return null;
        return values[2] === mappedHash
          ? {
              r2Key: `replay-assets/sha256/${mappedHash}`,
              contentType: "image/png",
              bytes: bytes.byteLength,
            }
          : null;
      },
    }),
  }));
  get.mockImplementation(async () => ({
    body: bytes,
    size: bytes.byteLength,
    httpEtag: '"asset-etag"',
  }));
  return { IDX_00: { prepare }, RECORDINGS: { get } } as unknown as Env;
}
