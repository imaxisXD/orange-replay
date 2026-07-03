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

  it("drops only events that cannot be JSON encoded", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const goodEvent = { type: 0, timestamp: 10, data: { href: "/plain" } } as eventWithTime;
    const badEvent = {
      type: 0,
      timestamp: 11,
      data: { amount: 10n },
    } as unknown as eventWithTime;

    const result = await serializeAndCompressBatch([goodEvent, badEvent]);

    expect(result.uncompressed).toBe(true);
    expect(result.droppedEventCount).toBe(1);
    expect(JSON.parse(decoder.decode(result.payload))).toEqual([goodEvent]);
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
