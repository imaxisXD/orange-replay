const WORKER_CORE_SOURCE = `
async function serializeAndCompressBatch(events) {
  const serialized = chunkReplayEvents(events);

  if (typeof CompressionStream !== "function") {
    return {
      payload: await encodeChunks(serialized.chunks),
      uncompressed: true,
      droppedEventCount: serialized.droppedEventCount,
    };
  }

  try {
    const compressed = await new Response(
      new Blob(serialized.chunks).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    return {
      payload: new Uint8Array(compressed),
      uncompressed: false,
      droppedEventCount: serialized.droppedEventCount,
    };
  } catch {
    return {
      payload: await encodeChunks(serialized.chunks),
      uncompressed: true,
      droppedEventCount: serialized.droppedEventCount,
    };
  }
}

function chunkReplayEvents(events) {
  const chunks = ["["];
  let droppedEventCount = 0;
  for (const event of events) {
    if (chunks.length > 1) chunks.push(",");
    if (event && Array.isArray(event.$)) {
      chunks.push(...event.$);
      continue;
    }
    try {
      chunks.push(JSON.stringify(event));
    } catch {
      droppedEventCount += 1;
      if (chunks[chunks.length - 1] === ",") chunks.pop();
    }
  }
  chunks.push("]");
  return { chunks, droppedEventCount };
}

async function encodeChunks(chunks) {
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}
`;

export function makeWorkerEntrySource(workerCoreSource = WORKER_CORE_SOURCE): string {
  return `
${workerCoreSource}

const events = [];
let treeEvent = null;
let treeChunks = [];
let suffixes = [];
let childCounts = [];

self.onmessage = (rawEvent) => {
  const message = rawEvent.data;
  switch (message[0]) {
    case "a":
      events.push(...message[1]);
      break;
    case "s":
      treeEvent = message[1];
      treeChunks = [];
      suffixes = [];
      childCounts = [];
      break;
    case "n":
      addSnapshotNodes(message);
      break;
    case "e":
      finishSnapshot();
      break;
    case "f":
      flushEvents(message);
      break;
    case "r":
      events.splice(0);
      treeEvent = null;
      treeChunks = [];
      suffixes = [];
      childCounts = [];
      break;
    case "x":
      self.close();
  }
};

function addSnapshotNodes(message) {
  const parts = [];
  for (let index = 0; index < message[1].length; index += 1) {
    const node = message[1][index];
    const depth = message[2][index];
    closeSnapshotNodes(depth, parts);
    if (depth > 0) {
      if (childCounts[depth - 1] > 0) parts.push(",");
      childCounts[depth - 1] += 1;
    }

    const json = JSON.stringify(node);
    const marker = '"childNodes":[]';
    const markerIndex = json.indexOf(marker);
    if (markerIndex === -1) {
      parts.push(json);
      continue;
    }
    parts.push(json.slice(0, markerIndex), '"childNodes":[');
    suffixes[depth] = "]" + json.slice(markerIndex + marker.length);
    suffixes.length = depth + 1;
    childCounts[depth] = 0;
    childCounts.length = depth + 1;
  }
  treeChunks.push(parts.join(""));
}

function finishSnapshot() {
  const parts = [];
  closeSnapshotNodes(0, parts);
  treeChunks.push(parts.join(""));
  const eventJson = JSON.stringify(treeEvent);
  const marker = '"node":null';
  const insertAt = eventJson.indexOf(marker);
  events.push({
    $: [
      eventJson.slice(0, insertAt) + '"node":',
      ...treeChunks,
      eventJson.slice(insertAt + marker.length),
    ],
  });
  treeEvent = null;
}

function closeSnapshotNodes(depth, parts) {
  while (suffixes.length > depth) {
    parts.push(suffixes.pop());
    childCounts.pop();
  }
}

function flushEvents(message) {
  const take = message[2] ?? events.length;
  const batchEvents = events.splice(0, take);
  void serializeAndCompressBatch(batchEvents)
    .then((result) => {
      const buffer = result.payload.buffer;
      self.postMessage(
        ["b", message[1], buffer, result.uncompressed, result.droppedEventCount],
        [buffer],
      );
    })
    .catch((error) => {
      const errorMessage =
        error instanceof Error ? error.message : typeof error === "string" ? error : "";
      self.postMessage([
        "b",
        message[1],
        null,
        null,
        0,
        errorMessage || "Orange Replay worker flush failed.",
      ]);
    });
}
`;
}
