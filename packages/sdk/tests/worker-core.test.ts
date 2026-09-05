import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { serializeAndCompressBatch } from "../src/pipeline/worker-core.ts";
import type { eventWithTime } from "@orange-replay/rrweb-fork";

const decoder = new TextDecoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("worker core", () => {
  it("serializes events and gzips the JSON batch", async () => {
    const events: eventWithTime[] = [
      { type: 0, timestamp: 10, data: { href: "/home" } } as eventWithTime,
    ];

    const result = await serializeAndCompressBatch(events);

    expect(result.uncompressed).toBe(false);
    const text = await gunzipToText(result.payload);
    expect(JSON.parse(text)).toEqual(events);
  });

  it("returns uncompressed bytes when CompressionStream is unavailable", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const events: eventWithTime[] = [
      { type: 0, timestamp: 10, data: { href: "/plain" } } as eventWithTime,
    ];

    const result = await serializeAndCompressBatch(events);

    expect(result.uncompressed).toBe(true);
    expect(JSON.parse(decoder.decode(result.payload))).toEqual(events);
  });

  it.each(["bigint", "cycle"])(
    "drops an optional %s event that cannot be JSON encoded",
    async (kind) => {
      vi.stubGlobal("CompressionStream", undefined);
      const goodEvent = { type: 0, timestamp: 10, data: { href: "/plain" } } as eventWithTime;
      const data: Record<string, unknown> = { amount: 10n };
      if (kind === "cycle") data["amount"] = data;
      const badEvent = {
        type: 0,
        timestamp: 11,
        data,
      } as unknown as eventWithTime;

      const result = await serializeAndCompressBatch([goodEvent, badEvent]);

      expect(result.uncompressed).toBe(true);
      expect(result.droppedEventCount).toBe(1);
      expect(JSON.parse(decoder.decode(result.payload))).toEqual([goodEvent]);
    },
  );

  it.each([2, 3])("stops when a DOM event of type %s cannot be JSON encoded", async (type) => {
    const badEvent = { type, timestamp: 10, data: { node: 10n } } as unknown as eventWithTime;
    await expect(serializeAndCompressBatch([badEvent])).rejects.toThrow();
  });
});

async function gunzipToText(payload: Uint8Array): Promise<string> {
  const body = new Response(payload as unknown as BodyInit).body;
  if (body === null) {
    throw new Error("test gzip body missing");
  }

  const plain = await new Response(body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return decoder.decode(plain);
}
