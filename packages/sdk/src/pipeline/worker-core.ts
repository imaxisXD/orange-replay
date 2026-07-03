import type { eventWithTime } from "@orange-replay/rrweb-fork";

export interface WorkerBatchResult {
  payload: Uint8Array;
  uncompressed: boolean;
  droppedEventCount?: number;
}

const encoder = new TextEncoder();

export async function serializeAndCompressBatch(
  events: readonly eventWithTime[],
): Promise<WorkerBatchResult> {
  const serialized = stringifyReplayEvents(events);
  const plainBytes = encoder.encode(serialized.json);

  if (typeof CompressionStream !== "function") {
    return {
      payload: plainBytes,
      uncompressed: true,
      droppedEventCount: serialized.droppedEventCount,
    };
  }

  try {
    const body = new Response(plainBytes).body;
    if (body === null) {
      return {
        payload: plainBytes,
        uncompressed: true,
        droppedEventCount: serialized.droppedEventCount,
      };
    }

    const compressed = await new Response(
      body.pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    return {
      payload: new Uint8Array(compressed),
      uncompressed: false,
      droppedEventCount: serialized.droppedEventCount,
    };
  } catch {
    return {
      payload: plainBytes,
      uncompressed: true,
      droppedEventCount: serialized.droppedEventCount,
    };
  }
}

function stringifyReplayEvents(events: readonly eventWithTime[]): {
  json: string;
  droppedEventCount: number;
} {
  try {
    return { json: JSON.stringify(events), droppedEventCount: 0 };
  } catch {
    const keptEvents: eventWithTime[] = [];
    let droppedEventCount = 0;

    for (const event of events) {
      try {
        JSON.stringify(event);
        keptEvents.push(event);
      } catch {
        droppedEventCount += 1;
      }
    }

    try {
      return {
        json: JSON.stringify(keptEvents),
        droppedEventCount,
      };
    } catch {
      return {
        json: "[]",
        droppedEventCount: events.length,
      };
    }
  }
}
