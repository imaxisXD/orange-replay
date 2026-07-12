import { getSnapshotEstimatedBytes } from "../../rrweb-snapshot/index.ts";
import {
  EventType,
  IncrementalSource,
  type eventWithTime,
  type mutationData,
  type serializedNodeWithId,
} from "../../rrweb-types/index.ts";

const SNAPSHOT_FALLBACK_BYTES = 128 * 1_024;
declare const __ORANGE_REPLAY_SDK_PROFILE__: boolean | undefined;
const isOrangeReplaySdk =
  typeof __ORANGE_REPLAY_SDK_PROFILE__ !== "undefined" && __ORANGE_REPLAY_SDK_PROFILE__;

export function estimateEventBytes(event: eventWithTime): number {
  if (event.type === EventType.FullSnapshot) {
    return getSnapshotEstimatedBytes(event.data.node) ?? SNAPSHOT_FALLBACK_BYTES;
  }
  if (event.type === EventType.Meta) return 512 + event.data.href.length * 2;
  if (event.type === EventType.Custom) return 4 * 1_024;
  if (event.type !== EventType.IncrementalSnapshot) return 512;
  if (event.data.source === IncrementalSource.Mutation) {
    if (event.data.isAttachIframe === true && event.data.adds.length === 1) {
      return getSnapshotEstimatedBytes(event.data.adds[0]!.node) ?? SNAPSHOT_FALLBACK_BYTES;
    }
    return estimateMutationBytes(event.data);
  }
  if (event.data.source === IncrementalSource.CanvasMutation && !isOrangeReplaySdk)
    return estimateCanvasFrameBytes(event.data);
  return 256 + estimateNestedBytes(event.data);
}

function estimateMutationBytes(data: mutationData): number {
  let bytes = 256 + data.removes.length * 32;
  for (const text of data.texts) bytes += estimateMutationTextBytes(text.value);
  for (const attribute of data.attributes) {
    bytes += estimateMutationAttributeBytes(attribute.attributes);
  }
  for (const addition of data.adds) {
    bytes +=
      32 + (getSnapshotEstimatedBytes(addition.node) ?? estimateAddedSnapshotBytes(addition.node));
  }
  return bytes;
}

function estimateAddedSnapshotBytes(root: serializedNodeWithId): number {
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    bytes += 48;
    if ("textContent" in node) bytes += node.textContent.length * 2;
    if ("attributes" in node) {
      bytes += node.tagName.length * 2;
      for (const [name, value] of Object.entries(node.attributes)) {
        bytes += name.length * 2 + estimateValueBytes(value);
      }
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) pending.push(child);
    }
  }
  return bytes;
}

export function estimateMutationTextBytes(value: string | null | undefined): number {
  return 24 + estimateStringBytes(value);
}

export function estimateMutationAttributeBytes(attributes: Record<string, unknown>): number {
  let bytes = 24;
  for (const [name, value] of Object.entries(attributes)) {
    bytes += name.length * 2 + estimateValueBytes(value);
  }
  return bytes;
}

export function estimateValueBytes(value: unknown): number {
  if (typeof value === "string") return estimateStringBytes(value);
  if (typeof value === "number") return 16;
  if (typeof value === "boolean") return 5;
  if (value === null || value === undefined) return 4;
  return 64;
}

function estimateCanvasFrameBytes(data: unknown): number {
  if (typeof data !== "object" || data === null) return 1_024;
  const commands = (data as { commands?: unknown }).commands;
  if (!Array.isArray(commands)) return 1_024;
  const draw = commands[1];
  if (typeof draw !== "object" || draw === null) return 1_024;
  const args = (draw as { args?: unknown }).args;
  if (!Array.isArray(args)) return 1_024;
  const image = args[0] as { args?: Array<{ data?: Array<{ base64?: unknown }> }> } | undefined;
  const base64 = image?.args?.[0]?.data?.[0]?.base64;
  return typeof base64 === "string" ? estimateStringBytes(base64) + 1_024 : 1_024;
}

export function estimateStringBytes(value: string | null | undefined): number {
  return value === null || value === undefined ? 0 : value.length * 2 + 2;
}

function estimateNestedBytes(value: unknown): number {
  if (typeof value === "string") return estimateStringBytes(value);
  if (typeof value !== "object" || value === null) return 16;
  return 32 + Object.values(value).reduce((bytes, item) => bytes + estimateNestedBytes(item), 0);
}
