import type { eventWithTime, serializedNodeWithId } from "@orange-replay/rrweb-fork";
import { REPLAY_DATA_LIMITS } from "@orange-replay/shared/constants";
import {
  REPLAY_VALUE_COUNTER_SOURCE,
  type ReplayValueCounter,
} from "@orange-replay/shared/replay-limits";
import {
  REPLAY_BATCH_SERIALIZER_SOURCE,
  type SerializedSnapshot,
  type serializeAndCompressBatch,
} from "./worker-core.ts";

type WorkerInput =
  | readonly ["a", eventWithTime[]]
  | readonly ["s", eventWithTime]
  | readonly ["n", serializedNodeWithId[], number[]]
  | readonly ["e"]
  | readonly ["f", number, number?]
  | readonly ["r"]
  | readonly ["x"];

export function makeWorkerEntrySource(
  workerCoreSource = REPLAY_BATCH_SERIALIZER_SOURCE,
  valueCounterSource = REPLAY_VALUE_COUNTER_SOURCE,
): string {
  return `${valueCounterSource}${workerCoreSource}(${startReplayWorker.toString()})(countReplayValues, serializeAndCompressBatch, ${REPLAY_DATA_LIMITS.values}, ${REPLAY_DATA_LIMITS.arrayItems});`;
}

// Every worker function is bundled by the same minifier as inline capture.
// Keep this factory self-contained so private properties agree across the boundary.
function startReplayWorker(
  countReplayValues: ReplayValueCounter,
  serializeBatch: typeof serializeAndCompressBatch,
  maxValues: number,
  maxArrayItems: number,
): void {
  const scope = self as unknown as {
    onmessage: (event: MessageEvent<WorkerInput>) => void;
    close(): void;
    postMessage(message: unknown, transfer?: Transferable[]): void;
  };
  const events: (eventWithTime | SerializedSnapshot)[] = [];
  let treeEvent: eventWithTime | null = null;
  let treeChunks: string[] = [];
  let suffixes: string[] = [];
  let childCounts: number[] = [];
  let snapshotValues = 0;

  scope.onmessage = (rawEvent) => {
    const message = rawEvent.data;
    switch (message[0]) {
      case "a":
        events.push(...message[1]);
        break;
      case "s":
        treeEvent = message[1];
        snapshotValues = countReplayValues(treeEvent) - 1;
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
        scope.close();
    }
  };

  function addSnapshotNodes(message: Extract<WorkerInput, readonly ["n", unknown, unknown]>) {
    if (treeEvent === null) throw new Error("Replay snapshot is missing its start.");
    const parts: string[] = [];
    for (let index = 0; index < message[1].length; index += 1) {
      const node = message[1][index]!;
      const depth = message[2][index]!;
      snapshotValues += countReplayValues(node, (treeEvent.type === 2 ? 2 : 4) + depth * 2);
      if (snapshotValues > maxValues) throw new Error("Replay batch is too complex.");
      closeSnapshotNodes(depth, parts);
      if (depth > 0) {
        if ((childCounts[depth - 1] ?? 0) > 0) parts.push(",");
        childCounts[depth - 1] = (childCounts[depth - 1] ?? 0) + 1;
        if (childCounts[depth - 1]! > maxArrayItems)
          throw new Error("Replay batch is too complex.");
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
    const parts: string[] = [];
    closeSnapshotNodes(0, parts);
    treeChunks.push(parts.join(""));
    const eventJson = JSON.stringify(treeEvent);
    const marker = '"node":null';
    const insertAt = eventJson.indexOf(marker);
    events.push({
      values: snapshotValues,
      $: [
        eventJson.slice(0, insertAt) + '"node":',
        ...treeChunks,
        eventJson.slice(insertAt + marker.length),
      ],
    });
    treeEvent = null;
    treeChunks = [];
  }

  function closeSnapshotNodes(depth: number, parts: string[]) {
    while (suffixes.length > depth) {
      parts.push(suffixes.pop()!);
      childCounts.pop();
    }
  }

  function flushEvents(message: Extract<WorkerInput, readonly ["f", number, number?]>) {
    const take = message[2] ?? events.length;
    const batchEvents = events.splice(0, take);
    void serializeBatch(batchEvents)
      .then((result) => {
        const buffer = result.payload.buffer;
        scope.postMessage(
          ["b", message[1], buffer, result.uncompressed, result.droppedEventCount],
          [buffer],
        );
      })
      .catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : typeof error === "string" ? error : "";
        scope.postMessage([
          "b",
          message[1],
          null,
          null,
          0,
          errorMessage || "Orange Replay worker flush failed.",
        ]);
      });
  }
}
