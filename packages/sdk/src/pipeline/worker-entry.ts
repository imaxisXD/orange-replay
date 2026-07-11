const WORKER_CORE_SOURCE = `
const encoder = new TextEncoder();

async function serializeAndCompressBatch(events) {
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

function stringifyReplayEvents(events) {
  try {
    return { json: JSON.stringify(events), droppedEventCount: 0 };
  } catch {
    const keptEvents = [];
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
`;

export function makeWorkerEntrySource(workerCoreSource = WORKER_CORE_SOURCE): string {
  return `
${workerCoreSource}

const events = [];

self.onmessage = (rawEvent) => {
  const message = rawEvent.data;

  if (message.type === "add") {
    events.push(...message.events);
    return;
  }

  if (message.type === "flush") {
    flushEvents(message);
    return;
  }

  if (message.type === "reset") {
    events.splice(0);
    return;
  }

  if (message.type === "stop") {
    self.close();
  }
};

function flushEvents(message) {
  const take = cleanTake(message.take, events.length);
  const batchEvents = events.splice(0, take);
  void serializeAndCompressBatch(batchEvents)
    .then((result) => {
      const buffer = toTransferBuffer(result.payload);
      self.postMessage(
        {
          type: "batch",
          id: message.id,
          payload: buffer,
          uncompressed: result.uncompressed,
          droppedEventCount: result.droppedEventCount,
        },
        [buffer],
      );
    })
    .catch((error) => {
      self.postMessage({
        type: "batch",
        id: message.id,
        error: stringFromUnknown(error) || "Orange Replay worker flush failed.",
      });
    });
}

function cleanTake(value, total) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return total;
  }

  return Math.min(total, Math.floor(value));
}

function toTransferBuffer(payload) {
  if (payload.byteOffset === 0 && payload.byteLength === payload.buffer.byteLength) {
    return payload.buffer;
  }

  return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
}

function stringFromUnknown(value) {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  return "";
}
`;
}
