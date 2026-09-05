import { beforeAll, expect, it, vi } from "vite-plus/test";
import { runInNewContext } from "node:vm";
import { decodeBatchWithStats } from "../src/worker-core.ts";
import { makeDecodeWorkerSource, type DecodeWorkerResponse } from "../src/worker-entry.ts";

const sharedChunk = vi.hoisted(() => ({ ready: false }));

// Production chunks can form a cycle: the player module loads before the shared
// counter is initialized, but playback starts after both chunks have finished.
vi.mock("@orange-replay/shared/replay-limits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@orange-replay/shared/replay-limits")>();
  return {
    get countReplayValues() {
      return sharedChunk.ready ? actual.countReplayValues : undefined;
    },
    get REPLAY_VALUE_COUNTER_SOURCE() {
      return sharedChunk.ready ? actual.REPLAY_VALUE_COUNTER_SOURCE : undefined;
    },
  };
});

beforeAll(() => {
  sharedChunk.ready = true;
});

const events = [{ type: 5, timestamp: 1_000, data: { tag: "saved", payload: { page: 1 } } }];
const payload = new TextEncoder().encode(JSON.stringify(events));

it("starts a generated decoder after its shared chunk finishes loading", async () => {
  const decoded = await new Promise<DecodeWorkerResponse>((resolve) => {
    const scope = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: resolve,
    };
    runInNewContext(makeDecodeWorkerSource(), {
      self: scope,
      Response,
      DecompressionStream,
      Uint8Array,
      TextDecoder,
    });
    scope.onmessage?.({ data: { type: "decode", id: 1, payload } });
  });
  expect(decoded).toMatchObject({ type: "decoded", events, decodedBytes: payload.byteLength });
});

it("starts the optional main-thread decoder after its shared chunk finishes loading", async () => {
  await expect(decodeBatchWithStats(payload)).resolves.toEqual({
    events,
    decodedBytes: payload.byteLength,
  });
});
