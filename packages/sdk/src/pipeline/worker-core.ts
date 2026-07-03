import type { eventWithTime } from "@orange-replay/rrweb-fork";

export interface WorkerBatchResult {
  payload: Uint8Array;
  uncompressed: boolean;
}

const encoder = new TextEncoder();

export async function serializeAndCompressBatch(
  events: readonly eventWithTime[],
): Promise<WorkerBatchResult> {
  const plainBytes = encoder.encode(JSON.stringify(events));

  if (typeof CompressionStream !== "function") {
    return { payload: plainBytes, uncompressed: true };
  }

  try {
    const body = new Response(plainBytes).body;
    if (body === null) {
      return { payload: plainBytes, uncompressed: true };
    }

    const compressed = await new Response(
      body.pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    return { payload: new Uint8Array(compressed), uncompressed: false };
  } catch {
    return { payload: plainBytes, uncompressed: true };
  }
}
