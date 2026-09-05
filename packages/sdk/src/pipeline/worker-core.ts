import type { eventWithTime } from "@orange-replay/rrweb-fork";
import { MAX_COMPRESSED_BATCH_BYTES, REPLAY_DATA_LIMITS } from "@orange-replay/shared/constants";
import { countReplayValues, type ReplayValueCounter } from "@orange-replay/shared/replay-limits";

export interface WorkerBatchResult {
  payload: Uint8Array;
  uncompressed: boolean;
  droppedEventCount?: number;
}

export interface SerializedSnapshot {
  $: string[];
  values: number;
}

const batchLimits = [
  REPLAY_DATA_LIMITS.bytes,
  REPLAY_DATA_LIMITS.events,
  REPLAY_DATA_LIMITS.values,
  MAX_COMPRESSED_BATCH_BYTES,
] as const;

// Keep the factory self-contained. Explicit inline capture and the Blob worker
// share the same serializer and resource checks without shipping two copies.
function createBatchSerializer(
  countValues: ReplayValueCounter,
  maxBytes: number,
  maxEvents: number,
  maxValues: number,
  maxPayloadBytes: number,
) {
  return async function serializeAndCompressBatch(
    events: readonly (eventWithTime | SerializedSnapshot)[],
    compress = true,
    dropInvalidEvents = true,
  ): Promise<WorkerBatchResult> {
    const chunks = ["["];
    let droppedEventCount = 0;
    let values = 0;
    for (const event of events) {
      const snapshot = event as SerializedSnapshot;
      if (Array.isArray(snapshot.$)) {
        values += snapshot.values;
        if (chunks.length > 1) chunks.push(",");
        chunks.push(...snapshot.$);
        continue;
      }
      let json: string;
      try {
        json = JSON.stringify(event);
      } catch (error) {
        // Missing DOM baselines would leave later mutations without their nodes.
        const replayEvent = event as eventWithTime;
        if (!dropInvalidEvents || replayEvent.type === 2 || replayEvent.type === 3) throw error;
        droppedEventCount += 1;
        continue;
      }
      values += countValues(event);
      if (chunks.length > 1) chunks.push(",");
      chunks.push(json);
    }
    if (values > maxValues) throw new Error("Replay batch is too complex.");
    if (events.length - droppedEventCount > maxEvents)
      throw new Error("Replay batch has too many events.");
    chunks.push("]");
    const blob = new Blob(chunks);
    if (blob.size > maxBytes) throw new Error("Replay batch is too large after decoding.");

    let compressed: ArrayBuffer | undefined;
    if (compress && typeof CompressionStream === "function") {
      try {
        compressed = await new Response(
          blob.stream().pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer();
      } catch {
        // Older browsers may expose the API without a working gzip stream.
      }
    }
    const payload = new Uint8Array(compressed ?? (await blob.arrayBuffer()));
    if (payload.byteLength > maxPayloadBytes) throw new Error("Replay batch is too large to send.");
    return { payload, uncompressed: compressed === undefined, droppedEventCount };
  };
}

export const serializeAndCompressBatch = createBatchSerializer(countReplayValues, ...batchLimits);
export const REPLAY_BATCH_SERIALIZER_SOURCE = `
const serializeAndCompressBatch = (${createBatchSerializer.toString()})(countReplayValues, ${batchLimits.join(",")});
`;
