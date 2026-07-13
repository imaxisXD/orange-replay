import { describe, expect, it } from "vite-plus/test";
import type { SessionRecorderStore } from "../src/do/session-recorder-store.ts";
import { SessionSegmentWriter } from "../src/do/session-segment-writer.ts";

describe("R2 create-only conflict checks", () => {
  it("compares a large sidecar as streams without buffering either object", async () => {
    const byteLength = 12 * 1024 * 1024;
    const existing = patternStream(byteLength, 73_123);
    const bucket = {
      async get() {
        return {
          size: byteLength,
          body: existing,
          async arrayBuffer() {
            throw new Error("the full R2 object must not be buffered");
          },
        };
      },
    } as unknown as ConstructorParameters<typeof SessionSegmentWriter>[1];
    const writer = new SessionSegmentWriter({} as SessionRecorderStore, bucket);

    await expect(
      writer.assertRecordingStreamMatches(
        "p/project/session/analytics.ndjson",
        patternStream(byteLength, 31_337),
        byteLength,
      ),
    ).resolves.toBeUndefined();
  }, 30_000);

  it("rejects a same-size sidecar with different streamed bytes", async () => {
    const byteLength = 256 * 1024;
    const bucket = {
      async get() {
        return {
          size: byteLength,
          body: patternStream(byteLength, 8_191),
        };
      },
    } as unknown as ConstructorParameters<typeof SessionSegmentWriter>[1];
    const writer = new SessionSegmentWriter({} as SessionRecorderStore, bucket);

    await expect(
      writer.assertRecordingStreamMatches(
        "p/project/session/analytics.ndjson",
        patternStream(byteLength, 4_093, byteLength - 2),
        byteLength,
      ),
    ).rejects.toThrow("does not match expected object");
  });
});

function patternStream(
  totalBytes: number,
  chunkBytes: number,
  changedByteAt = -1,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= totalBytes) {
        controller.close();
        return;
      }
      const length = Math.min(chunkBytes, totalBytes - offset);
      const chunk = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        const absoluteIndex = offset + index;
        chunk[index] = absoluteIndex % 251;
        if (absoluteIndex === changedByteAt) chunk[index] = (chunk[index] ?? 0) ^ 1;
      }
      offset += length;
      controller.enqueue(chunk);
    },
  });
}
